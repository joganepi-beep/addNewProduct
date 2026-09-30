#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPlan, resolveImages, normalizeClothingFacts, validateApprovedPlan } = require('./plan.cjs');
const { resolveImagePath, resolvePlanImages, portablePlanImages } = require('./paths.cjs');

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}

function usage() {
  console.log(`用法：
  node src/cli.cjs browser
  node src/cli.cjs doctor --cdp http://127.0.0.1:9222
  node src/cli.cjs prepare 商品.json --output plans/商品.plan.json
  node src/cli.cjs prepare 商品.json --offline --output plans/商品.plan.json
  node src/cli.cjs apply plans/商品.plan.json --dry-run
  node src/cli.cjs apply plans/商品.plan.json --cdp http://127.0.0.1:9222
  node src/cli.cjs handcard run-logs/handcard-data/某次保存.json

prepare 默认调用图片模型；--offline 要求输入文件提供完整 copyOverrides。
apply 只点击“保存草稿”，不会提交审核或发布；保存后生成 PPTX/PDF 手卡。`);
}

async function main() {
  const [command, filename, ...args] = process.argv.slice(2);
  if (!command || args.includes('--help')) { usage(); return; }
  if (command === 'browser') {
    console.log(JSON.stringify(require('./cdp.cjs').launchBrowser(Number(option(process.argv.slice(2), '--port', 9222))), null, 2));
    console.log('请在新打开的 Chrome/Edge 中自行扫码登录，并打开快手小店。');
    return;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify(await require('./cdp.cjs').doctor(option(process.argv.slice(2), '--cdp', 'http://127.0.0.1:9222')), null, 2));
    return;
  }
  if (!filename) { usage(); return; }
  const absolute = path.resolve(filename);
  const source = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (command === 'handcard') {
    const modulePath = path.resolve(__dirname, '..', 'scripts', 'handcard.mjs');
    const { buildHandcard } = await import(pathToFileURL(modulePath).href);
    const data = { ...source, image: resolveImagePath(source.image, absolute) };
    console.log(JSON.stringify(await buildHandcard(data, undefined, option(args, '--size', 'half')), null, 2));
    return;
  }
  if (command === 'prepare') {
    const data = source;
    const images = resolveImages(data, absolute);
    const prepared = { ...data, facts: normalizeClothingFacts(data.categoryPath, data.facts,
      !!data.images?.label?.length, { deferFitDefault: true }) };
    const generated = args.includes('--offline') ? {} : await require('./vision.cjs').generateCopy(prepared, images);
    const plan = createPlan(data, absolute, generated);
    const output = path.resolve(option(args, '--output', path.join('plans', `${path.basename(filename, '.json')}.plan.json`)));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(portablePlanImages(plan, output), null, 2) + '\n');
    console.log(`方案已生成：${output}`);
    console.log(`待核对：${plan.pending.length ? plan.pending.join('、') : '无'}`);
    console.log('请审核方案，将 review.approved 改为 true 后再执行 apply。');
    return;
  }
  if (command === 'apply') {
    const data = resolvePlanImages(source, absolute);
    if (args.includes('--dry-run')) {
      validateApprovedPlan(data);
      console.log(JSON.stringify({
        mode: data.mode,
        category: data.categoryPath,
        title: data.copy.title,
        styleNumber: data.facts.styleNumber || null,
        images: { main: data.images.main.length, detail: data.images.detail.length },
        colors: data.facts.colors || (data.facts.color ? [data.facts.color] : []),
        sizes: data.facts.sizes || [],
        sizeRemarks: data.facts.sizeRemarks || {},
        presaleDays: data.facts.presaleDays,
        shippingTemplate: data.facts.shippingTemplate,
        immediateListing: data.facts.immediateListing,
        priceYuan: data.facts.priceYuan,
        handcardPriceYuan: data.facts.handcardPriceYuan ?? null,
        stockPerSku: data.facts.stockPerSku,
        pending: data.pending
      }, null, 2));
      return;
    }
    const endpoint = option(args, '--cdp', 'http://127.0.0.1:9222');
    const audit = require('./audit.cjs').createAudit(absolute);
    const started = process.hrtime.bigint();
    let lastStep = started;
    const originalLog = console.log;
    audit.record('start', {
      title: data.copy.title,
      category: data.categoryPath.join(' > '),
      mode: data.mode,
      imageCounts: { main: data.images.main.length, detail: data.images.detail.length,
        label: data.images.label?.length || 0 }
    });
    console.log = (...parts) => {
      originalLog(...parts);
      const now = process.hrtime.bigint();
      audit.record('step', { message: parts.map(String).join(' '),
        elapsedMs: Number(now - started) / 1e6,
        sincePreviousStepMs: Number(now - lastStep) / 1e6 });
      lastStep = now;
    };
    try {
      validateApprovedPlan(data);
      const result = await require('./browser.cjs').applyPlan(data, endpoint);
      result.elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      result.auditLog = audit.file;
      audit.record('saved', { elapsedSeconds: result.elapsedSeconds, timestamp: result.timestamp });
      if (result.handcardData) {
        const snapshotDir = path.resolve('run-logs', 'handcard-data');
        await fs.mkdir(snapshotDir, { recursive: true });
        const snapshotPath = path.join(snapshotDir, `${path.basename(audit.file, '.jsonl')}.json`);
        await fs.writeFile(snapshotPath, JSON.stringify(result.handcardData, null, 2) + '\n');
        result.handcardSnapshot = snapshotPath;
        try {
          const modulePath = path.resolve(__dirname, '..', 'scripts', 'handcard.mjs');
          const { buildHandcard } = await import(pathToFileURL(modulePath).href);
          result.handcard = await buildHandcard(result.handcardData);
          audit.record('handcard', { pptx: result.handcard.pptxPath, pdf: result.handcard.pdfPath });
          console.log(`已生成可编辑 PPTX：${result.handcard.pptxPath}`);
          console.log(`已生成打印 PDF：${result.handcard.pdfPath}`);
        } catch (error) {
          result.handcardError = error.message;
          audit.record('handcard_failed', { error: error.message, snapshotPath });
          console.log(`草稿已保存，但手卡生成失败：${error.message}`);
          process.exitCode = 1;
        }
        delete result.handcardData;
      } else if (result.handcardReadError) {
        audit.record('handcard_failed', { error: result.handcardReadError });
        process.exitCode = 1;
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      audit.record('failed', { error: error.message, elapsedSeconds: seconds });
      error.message += `\n本次耗时：${seconds.toFixed(1)} 秒\n运行日志：${audit.file}`;
      throw error;
    } finally {
      console.log = originalLog;
    }
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
