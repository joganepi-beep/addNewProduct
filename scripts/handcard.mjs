import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveImagePath } = require('../src/paths.cjs');

const root = path.resolve(import.meta.dirname, '..');
const runtimeRoot = path.join(os.homedir(), '.cache', 'codex-runtimes',
  'codex-primary-runtime', 'dependencies');
const runtimeNodeModules = process.env.RUNTIME_NODE_MODULES || path.join(runtimeRoot, 'node', 'node_modules');
process.env.RUNTIME_NODE_MODULES ||= runtimeNodeModules;
const skillVersions = path.join(os.homedir(), '.codex', 'plugins', 'cache',
  'openai-primary-runtime', 'presentations');
async function presentationSkillDir() {
  if (process.env.CODEX_PRESENTATIONS_SKILL_DIR) return process.env.CODEX_PRESENTATIONS_SKILL_DIR;
  const versions = await fs.readdir(skillVersions).catch(() => []);
  for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const candidate = path.join(skillVersions, version, 'skills', 'presentations');
    if (await fs.access(path.join(candidate, 'container_tools', 'artifact_tool_utils.mjs'))
      .then(() => true, () => false)) return candidate;
  }
  throw new Error('找不到 Codex 演示文稿运行环境；请设置 CODEX_PRESENTATIONS_SKILL_DIR');
}
const skillDir = await presentationSkillDir();
const pythonExecutable = process.env.PYTHON || path.join(runtimeRoot, 'python',
  process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const artifactModule = path.join(runtimeNodeModules, '@oai', 'artifact-tool', 'dist', 'artifact_tool.mjs');
const { Presentation, PresentationFile } = await import(pathToFileURL(artifactModule).href);
const { finalizePresentation } = await import(pathToFileURL(
  path.join(skillDir, 'container_tools', 'artifact_tool_utils.mjs')).href);

const font = 'Microsoft YaHei';
const navy = '#0B3170';
const dark = '#213347';
const pale = '#F1F5F9';
const layouts = {
  a4: { width: 1122, height: 794, image: [42, 72, 250, 461], table: [304, 72, 778, 461],
    columns: [115, 143, 118, 152, 116, 134], rows: [76, 68, 155, 90, 72], fontSize: 19, titleSize: 18,
    pdfMm: [297, 210], label: 'A4' },
  half: { width: 794, height: 561, image: [24, 30, 170, 465], table: [210, 30, 560, 465],
    columns: [70, 105, 75, 105, 85, 120], rows: [75, 68, 145, 95, 82], fontSize: 16, titleSize: 16,
    pdfMm: [210, 148.5], label: 'A4一半' },
  third: { width: 794, height: 374, image: [16, 18, 150, 338], table: [178, 18, 600, 338],
    columns: [75, 110, 75, 115, 85, 140], rows: [56, 48, 102, 68, 64], fontSize: 15, titleSize: 15,
    pdfMm: [210, 99], label: 'A4三分之一' },
};

function safeName(value) {
  return String(value || '商品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 42);
}

function requireCard(card) {
  if (!card || typeof card !== 'object') throw new Error('手卡数据必须为对象');
  if (!card.saved || !card.savedAt) throw new Error('尚未确认保存草稿，不能生成手卡');
  if (!card.title || !card.image) throw new Error('手卡缺少商品标题或商品图');
  if (!Array.isArray(card.colors) || !card.colors.length) throw new Error('手卡缺少颜色');
  if (!Array.isArray(card.sizes) || !card.sizes.length) throw new Error('手卡缺少尺码');
}

function cellText(value) {
  return value == null || value === '' ? '未提供' : String(value);
}

function firstImageMime(file) {
  return /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
}

function cardTable(slide, card, layout, topOffset = 0) {
  const remarks = card.sizes.map(size => `${size} ${card.sizeRemarks?.[size] || ''}`.trim()).join('\n');
  const material = card.material
    ? (card.compositionExact || `${card.material}${card.composition ? ` ${card.composition}` : '（比例未提供）'}`)
    : '未提供';
  const rows = [
    [`款号 + 名称  ${card.title}`, '', '', '', `品牌：${cellText(card.brand)}\n日期：${cardDay(card)}`, ''],
    ['售价', card.priceYuan == null || card.priceYuan === 9999 ? '' : `￥${card.priceYuan}`,
      '吊牌价', cellText(card.tagPriceYuan), '佣金', '10%'],
    ['尺码', remarks, '', '', '颜色', card.colors.join('、')],
    ['面料成分', material, '', '', card.garmentLengthLabel || '衣长', cellText(card.garmentLength)],
    ['发货时效', card.presaleDays == null ? '未提供' : `预售 ${card.presaleDays} 天`,
      '', '', '商家', card.merchant || ''],
  ];
  const table = slide.tables.add({
    rows: rows.length, columns: 6,
    left: layout.table[0], top: layout.table[1] + topOffset, width: layout.table[2], height: layout.table[3],
    columnWidths: layout.columns, values: rows,
  });
  table.merge({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 });
  table.merge({ startRow: 0, endRow: 0, startColumn: 4, endColumn: 5 });
  for (const row of [2, 3, 4]) {
    table.merge({ startRow: row, endRow: row, startColumn: 1, endColumn: 3 });
  }
  for (let r = 0; r < rows.length; r++) {
    table.rows[r].height = layout.rows[r];
    for (let c = 0; c < 6; c++) {
      const cell = table.getCell(r, c);
      cell.fill = r === 0 ? navy : (r % 2 === 0 ? pale : '#FFFFFF');
      cell.text.style = {
        typeface: font, fontSize: r === 0 ? layout.titleSize : layout.fontSize,
        bold: r === 0 || c === 0 || c === 2 || c === 4,
        color: r === 0 ? '#FFFFFF' : (c === 0 || c === 2 || c === 4 ? navy : dark),
        autoFit: 'shrinkText', wrap: 'square',
      };
    }
  }
  table.borders.assign({ style: 'solid', fill: '#CFD8E3', width: 1 });
  return table;
}

function productKey(card) {
  return String(card.styleNumber || card.title).trim().toUpperCase();
}

function cardDay(card) {
  const day = String(card.savedAt || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`手卡保存日期无效：${card.savedAt}`);
  return day;
}

export async function loadUniqueHandcards(snapshotDir, currentCard = null) {
  if (!currentCard) throw new Error('请提供当天一件已保存的商品，以确定手卡日期');
  requireCard(currentCard);
  const day = cardDay(currentCard);
  const files = (await fs.readdir(snapshotDir).catch(() => [])).filter(file => file.endsWith('.json'));
  const records = [];
  for (const file of files) {
    const source = path.join(snapshotDir, file);
    const data = JSON.parse(await fs.readFile(source, 'utf8'));
    if (cardDay(data) !== day) continue;
    requireCard(data);
    records.push({ card: { ...data, image: resolveImagePath(data.image, source) }, source });
  }
  records.sort((a, b) => a.card.savedAt.localeCompare(b.card.savedAt) || a.source.localeCompare(b.source));
  const unique = new Map();
  for (const record of records) unique.set(productKey(record.card), record.card);
  unique.set(productKey(currentCard), {
    ...currentCard,
    image: resolveImagePath(currentCard.image, path.join(root, 'run-logs', 'handcard-data', 'current.json')),
  });
  return [...unique.values()];
}

async function removeEarlierHandcardFiles(directory, keepFile, extension) {
  for (const name of await fs.readdir(directory)) {
    if (name === path.basename(keepFile) || !name.endsWith(extension) || !name.includes('手卡')) continue;
    await fs.unlink(path.join(directory, name));
  }
}

export async function buildHandcard(card, outputDir = path.join(root, 'output', 'handcards'), size = 'half') {
  if (size !== 'half') throw new Error('总手卡固定为 A4 竖版，每页上下两件商品');
  const layout = layouts.half;
  const cards = await loadUniqueHandcards(path.join(root, 'run-logs', 'handcard-data'), card);
  if (!cards.length) throw new Error('没有已保存的手卡数据');
  const day = cardDay(card);
  await fs.mkdir(outputDir, { recursive: true });
  const pdfDir = path.join(root, 'output', 'pdf');
  await fs.mkdir(pdfDir, { recursive: true });
  const pptxPath = path.join(outputDir, `${day}-商品手卡-可编辑.pptx`);
  const pdfPath = path.join(pdfDir, `${day}-商品手卡-A4双拼.pdf`);
  await fs.mkdir(path.join(root, 'tmp', 'handcards'), { recursive: true });
  const buildDir = await fs.mkdtemp(path.join(root, 'tmp', 'handcards', 'master-'));
  await fs.mkdir(buildDir, { recursive: true });
  const presentation = Presentation.create({ slideSize: { width: 794, height: 1122 } });
  let firstSlide;
  for (let index = 0; index < cards.length; index += 2) {
    const slide = presentation.slides.add();
    firstSlide ||= slide;
    slide.background.fill = '#FFFFFF';
    for (let slot = 0; slot < 2 && index + slot < cards.length; slot++) {
      const item = cards[index + slot];
      const top = slot * layout.height;
      const imageBytes = await fs.readFile(item.image);
      slide.images.add({
        blob: new Uint8Array(imageBytes), contentType: firstImageMime(item.image),
        alt: `${item.styleNumber || item.title}商品图`, fit: 'contain',
        position: { left: layout.image[0], top: layout.image[1] + top,
          width: layout.image[2], height: layout.image[3] },
      });
      cardTable(slide, item, layout, top);
    }
    slide.speakerNotes.textFrame.setText(cards.slice(index, index + 2).map(item =>
      `${item.styleNumber || item.title}｜来源：${item.sourceUrl || '暂无商品链接'}｜待核对：${item.pending?.join('；') || '无'}`
    ).join('\n'));
  }

  const candidatePath = path.join(buildDir, 'candidate.pptx');
  const previewPath = path.join(buildDir, 'preview.png');
  await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
  const preview = await presentation.export({ slide: firstSlide, format: 'png', scale: 1 });
  await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  const validatedPath = path.join(outputDir, `.validated-${path.basename(buildDir)}.pptx`);
  await finalizePresentation({
    workspaceDir: root, candidatePath, finalPath: validatedPath,
    pythonExecutable,
    integrityValidatorPath: path.join(skillDir, 'container_tools', 'inspect_presentation_package_integrity.py'),
    layoutValidatorPath: path.join(skillDir, 'container_tools', 'inspect_presentation_layout_geometry.py'),
    layoutArgs: ['--expected-slide-size-emu', `${794 * 9525},${1122 * 9525}`,
      '--validate-heading-fit', '--require-native-table-slide', '1'],
    requiredNativeTableOwnerSlides: [1],
    fontPolicy: { basis: 'design', families: [font] },
    verifyArtifactToolImport: true,
    receiptPath: path.join(buildDir, 'validation.json'),
  });
  const { spawnSync } = await import('node:child_process');
  const pdfScript = path.join(import.meta.dirname, 'handcard-pdf.py');
  const pdfDataPath = path.join(buildDir, 'pdf-data.json');
  await fs.writeFile(pdfDataPath, JSON.stringify({ cards, layout }, null, 2) + '\n');
  const validatedPdf = path.join(buildDir, 'validated.pdf');
  const pdf = spawnSync(pythonExecutable, [pdfScript, pdfDataPath, validatedPdf], { encoding: 'utf8' });
  if (pdf.status !== 0) throw new Error(`PDF 导出失败：${pdf.error?.message || pdf.stderr || pdf.stdout}`);
  await fs.copyFile(validatedPath, `${pptxPath}.tmp`);
  await fs.rename(`${pptxPath}.tmp`, pptxPath);
  await fs.unlink(validatedPath);
  await fs.copyFile(validatedPdf, `${pdfPath}.tmp`);
  await fs.rename(`${pdfPath}.tmp`, pdfPath);
  await removeEarlierHandcardFiles(outputDir, pptxPath, '.pptx');
  await removeEarlierHandcardFiles(pdfDir, pdfPath, '.pdf');
  return { pptxPath, pdfPath, previewPath, day, products: cards.length, pages: Math.ceil(cards.length / 2) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('用法：node scripts/handcard.mjs card.json');
  const card = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8'));
  card.image = resolveImagePath(card.image, path.resolve(inputPath));
  console.log(JSON.stringify(await buildHandcard(card, undefined, process.argv[3] || 'half'), null, 2));
}
