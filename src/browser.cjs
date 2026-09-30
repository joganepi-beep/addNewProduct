const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { SITE, validateApprovedPlan } = require('./plan.cjs');
const { prepareMainImages } = require('./images.cjs');
const { exactComposition } = require('./composition.cjs');

const FORM_TIMEOUT = 15000;
const CATEGORY_TIMEOUT = 45000;
const exact = value => new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const log = message => console.log(`[上架草稿] ${message}`);

async function dismissKnownGuidance(page) {
  let dismissed = 0;
  for (let i = 0; i < 30; i++) {
    const presaleWarning = page.getByRole('dialog').filter({ hasText: '若有现货库存' });
    if (await presaleWarning.isVisible().catch(() => false)) {
      await presaleWarning.getByRole('button', { name: '继续设置预售' }).click({ timeout: 3000 });
      await presaleWarning.waitFor({ state: 'hidden', timeout: FORM_TIMEOUT });
      log('已确认“继续设置预售”；发货天数稍后核对为 15 天');
      dismissed++;
      continue;
    }
    const button = page.getByRole('button', { name: '知道了', exact: true })
      .filter({ visible: true }).last();
    if (!await button.count()) break;
    try {
      await button.click({ timeout: 3000 });
    } catch (error) {
      if (await page.getByRole('button', { name: '知道了', exact: true })
        .filter({ visible: true }).count()) throw error;
    }
    dismissed++;
    await page.waitForTimeout(50);
  }
  if (dismissed) log(`已关闭 ${dismissed} 个后台引导提示`);
}

async function connectToProductTab(endpoint, plan) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000, noDefaults: true });
  } catch (error) {
    throw new Error(`无法连接 CDP ${endpoint}。请先在已登录的 Edge/Chrome 开启远程调试端口；Codex 内置浏览器不会自动开放本地端口。原始错误：${error.message}`);
  }
  try {
    const pages = browser.contexts().flatMap(context => context.pages());
    if (plan.resumeUnsaved === true && !plan.draftId) {
      const candidates = [];
      for (const candidate of pages) {
        if (!candidate.url().startsWith(`${SITE}/zone/goods/nexus/self/release/add`)) continue;
        const title = candidate.getByRole('textbox', { name: /最多输入30个汉字/ });
        if (await title.count() && await title.inputValue() === plan.copy.title) candidates.push(candidate);
      }
      if (candidates.length !== 1) throw new Error(`待续填的未保存商品页面需要唯一匹配标题，找到 ${candidates.length} 个`);
      const page = candidates[0];
      await page.bringToFront();
      page.setDefaultTimeout(FORM_TIMEOUT);
      log('已接续填写上次停在校验前的未保存表单');
      return { browser, page };
    }
    if (!plan.draftId) {
      const shopPage = pages.find(page => {
        try { return new URL(page.url()).hostname === 's.kwaixiaodian.com'; }
        catch { return false; }
      });
      if (!shopPage) throw new Error('找不到已登录的快手小店标签页');
      const page = await shopPage.context().newPage();
      await page.goto(`${SITE}/zone/goods/nexus/self/release/add`, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      page.setDefaultTimeout(FORM_TIMEOUT);
      log('已新建独立的商品发布标签页，保留原有页面内容');
      return { browser, page };
    }
    const matches = pages.filter(page => {
      try {
        const url = new URL(page.url());
        return url.hostname === 's.kwaixiaodian.com'
          && url.pathname === '/zone/goods/nexus/self/release/add';
      }
      catch { return false; }
    });
    if (matches.length !== 1) throw new Error(`需要且只能有一个快手小店“新增商品”标签页，找到 ${matches.length} 个`);
    const page = matches[0];
    if (!page.url().startsWith(`${SITE}/zone/goods/nexus/self/release/add`)) {
      throw new Error('请先在已登录的浏览器中打开“新增商品”页面，再运行 apply');
    }
    const currentId = new URL(page.url()).searchParams.get('itemDraftId');
    if (currentId && currentId !== plan.draftId) {
      throw new Error(`当前页面草稿 ID ${currentId} 与方案 ID ${plan.draftId || '新商品'} 不一致，已停止以防覆盖`);
    }
    await page.bringToFront();
    page.setDefaultTimeout(FORM_TIMEOUT);
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function uploadViaPicker(page, button, files) {
  const nestedInput = button.locator('input[type="file"]');
  if (await nestedInput.count()) {
    const multiple = await nestedInput.getAttribute('multiple') !== null;
    const selected = multiple ? files : files.slice(0, 1);
    await nestedInput.setInputFiles(selected);
    return selected.length;
  }
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
  await button.click();
  const local = page.getByText('本地上传', { exact: true });
  if (await local.isVisible().catch(() => false)) await local.click();
  const chooser = await chooserPromise;
  if (!chooser) throw new Error('上传入口没有打开文件选择器');
  const selected = chooser.isMultiple() ? files : files.slice(0, 1);
  await chooser.setFiles(selected);
  return selected.length;
}

async function mainImageCount(page) {
  const button = page.getByRole('button', { name: /上传图片\(\d+\/9\)/ }).first();
  const name = await button.innerText();
  return { button, count: Number(name.match(/\((\d+)\/9\)/)?.[1] || 0) };
}

async function ensureMainImages(page, images) {
  const { count } = await mainImageCount(page);
  if (count === images.length) { log(`主图已有 ${count} 张，跳过上传；请在方案审核时核对图片内容`); return; }
  if (count !== 0) throw new Error(`主图已有 ${count} 张，但方案要求 ${images.length} 张；请人工核对后再运行`);
  let sent = 0;
  while (sent < images.length) {
    const current = await mainImageCount(page);
    if (current.count !== sent) throw new Error(`主图上传状态不一致：${current.count}/${sent}`);
    sent += await uploadViaPicker(page, current.button, images.slice(sent));
    await page.getByRole('button', { name: new RegExp(`上传图片\\(${sent}\\/9\\)`) })
      .first().waitFor({ state: 'visible', timeout: 15000 });
    if (await page.getByText(/图片长宽比需1:1/).first().isVisible().catch(() => false)) {
      throw new Error('主图不是平台要求的 1:1 方图；已停止，未应用自动裁剪');
    }
  }
  const after = await mainImageCount(page);
  if (after.count < images.length) throw new Error(`主图上传未完成：页面显示 ${after.count}/${images.length}`);
  log(`主图上传 ${after.count} 张`);
}

async function resolveExistingDraft(page, plan) {
  const dialog = page.getByRole('dialog').filter({ hasText: /已有草稿|请确认商品创建方式/ });
  if (!await dialog.isVisible().catch(() => false)) return false;
  const dialogText = await dialog.innerText();
  const draftId = dialogText.match(/商品ID:\s*(\d+)/)?.[1] || '未知';
  if (!dialogText.includes('不使用已有商品信息')) {
    throw new Error(`“发布全新商品”选项缺少不沿用旧信息的说明（草稿 ID ${draftId}），脚本未作选择`);
  }
  await dialog.getByText('发布全新商品', { exact: true }).click();
  if (!await dialog.locator('input[type="radio"][value="new"]').isChecked()) {
    throw new Error('“发布全新商品”未选中，脚本未确认弹窗');
  }
  await dialog.getByRole('button', { name: /确\s*定/ }).click();
  await dialog.waitFor({ state: 'hidden', timeout: FORM_TIMEOUT });
  await page.getByRole('textbox', { name: /最多输入30个汉字/ })
    .waitFor({ state: 'visible', timeout: FORM_TIMEOUT });
  log(`已按方案选择“发布全新商品”，未沿用旧草稿 ${draftId}`);
  return true;
}

async function ensureCategory(page, categoryPath, plan) {
  if (await page.getByRole('textbox', { name: /最多输入30个汉字/ }).count()) return;
  const search = page.getByPlaceholder('请输入关键词搜索商品类目');
  if (!await search.count()) throw new Error('找不到类目搜索框');
  await search.fill(categoryPath.at(-1));
  const full = categoryPath.join(' > ');
  const match = page.getByRole('list').getByText(full, { exact: true });
  await match.waitFor({ state: 'visible', timeout: 10000 });
  await match.click();
  log(`类目已选择：${full}；等待后台打开商品信息表单`);
  const nextButton = page.getByRole('button', { name: '下一步，完善商品信息' });
  await nextButton.click();
  async function waitForOutcome(timeout) {
    return page.waitForFunction(() => {
    const visible = element => element && element.getClientRects().length > 0;
    if (visible(document.querySelector('input[placeholder*="最多输入30个汉字"]'))) return 'form';
    if ([...document.querySelectorAll('[role="dialog"]')]
      .some(element => visible(element) && /已有草稿|请确认商品创建方式/.test(element.textContent))) return 'draft';
    return null;
    }, null, { timeout }).catch(error => {
      if (error.name === 'TimeoutError') return null;
      throw error;
    });
  }
  let next = await waitForOutcome(10000);
  if (!next && await nextButton.isVisible().catch(() => false)) {
    log('类目页 10 秒后仍未切换，重试一次“下一步”');
    await nextButton.click({ timeout: 3000 }).catch(async error => {
      if (!await page.getByRole('textbox', { name: /最多输入30个汉字/ }).count()) throw error;
    });
    next = await waitForOutcome(CATEGORY_TIMEOUT - 10000);
  }
  if (!next) throw new Error(`类目“${full}”确认后 ${CATEGORY_TIMEOUT / 1000} 秒仍未进入商品信息表单，请检查后台页面提示`);
  const outcome = await next.jsonValue();
  if (outcome === 'draft') {
    await resolveExistingDraft(page, plan);
  }
  if (await page.getByRole('dialog').filter({ visible: true }).count()) {
    throw new Error('页面出现未识别弹窗，请人工核对后重试');
  }
  log(`类目：${full}`);
}

function attributeRow(page, label) {
  return page.locator('.kwaishop-goods-nexus-pc-formily-item')
    .filter({ has: page.locator('label').filter({ hasText: exact(label) }) }).last();
}

function selectedAttribute(row, value) {
  return row.locator('.kwaishop-goods-nexus-pc-select-selection-item')
    .filter({ hasText: value === '95%以上' ? /95%.*以上/ : exact(value) });
}

async function selectAttribute(page, label, value) {
  if (label === '服装版型' && value === '常规') value = '常规款';
  const searchValue = label === '成分含量' && value === '95%以上' ? '95%' : value;
  await dismissKnownGuidance(page);
  const row = attributeRow(page, label);
  if (!await row.count()) throw new Error(`找不到商品属性：${label}`);
  if (await selectedAttribute(row, value).count()) {
    log(`商品属性 ${label} 已是：${value}`);
    return true;
  }
  const combo = row.getByRole('combobox').first();
  const selector = row.locator('.kwaishop-goods-nexus-pc-select-selector').first();
  async function openSelector(timeout) {
    await combo.evaluate(element => element.scrollIntoView({ block: 'center' }));
    if (await row.locator('.kwaishop-goods-nexus-pc-select-multiple').count()) {
      const box = await selector.boundingBox();
      if (!box) throw new Error(`${label} 下拉框不可见`);
      await selector.click({ position: { x: 25, y: box.height / 2 }, timeout });
    } else {
      await selector.click({ timeout });
    }
  }
  try {
    await openSelector(3000);
  } catch (error) {
    const knownDialog = page.getByRole('dialog').filter({ hasText: /系统预填内容更新|若有现货库存/ });
    if (!await knownDialog.isVisible().catch(() => false)) throw error;
    await dismissKnownGuidance(page);
    await openSelector(5000);
  }
  await combo.fill(searchValue);
  const optionText = label === '成分含量' && value === '95%以上' ? /95%.*以上/ : exact(value);
  const item = page.locator('.kwaishop-goods-nexus-pc-select-item-option')
    .filter({ hasText: optionText }).filter({ visible: true }).first();
  try {
    await item.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    await combo.fill('');
    await combo.press('Escape');
    log(`${label}没有可选值“${value}”，已留空并标记待人工核对`);
    return false;
  }
  async function chooseItem(timeout) {
    const labelNode = item.locator('label');
    if (await labelNode.count()) await labelNode.click({ timeout });
    else await item.click({ timeout });
  }
  try {
    await chooseItem(4000);
  } catch (error) {
    const knownNotice = page.getByRole('dialog').filter({ hasText: '系统预填内容更新' });
    if (error.name !== 'TimeoutError') throw error;
    if (await selectedAttribute(row, value).count()) return true;
    if (await knownNotice.isVisible().catch(() => false)) await dismissKnownGuidance(page);
    await openSelector(5000);
    await combo.fill(searchValue);
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await chooseItem(5000);
  }
  await dismissKnownGuidance(page);
  const title = page.getByRole('textbox', { name: /最多输入30个汉字/ });
  try {
    await title.click({ timeout: 3000 });
  } catch (error) {
    const knownNotice = page.getByRole('dialog')
      .filter({ hasText: /系统预填内容更新|3:4主图已帮您智能裁切/ });
    if (!await knownNotice.isVisible().catch(() => false)) throw error;
    await dismissKnownGuidance(page);
    await title.click({ timeout: 5000 });
  }
  // The shop can apply its attribute suggestions after the click, sometimes a few
  // seconds later. Wait for the actual selected tag before treating it as failed.
  await row.locator('.kwaishop-goods-nexus-pc-select-selection-item')
    .filter({ hasText: optionText }).waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => { throw new Error(`${label} 未写入：${value}`); });
  log(`商品属性 ${label}：${value}`);
  return true;
}

async function ensureExactFabric(page, expected) {
  if (!Array.isArray(expected)) return;
  const row = attributeRow(page, '面料材质');
  const selected = row.locator('.kwaishop-goods-nexus-pc-select-selection-item');
  for (const item of await selected.allInnerTexts()) {
    const value = item.trim();
    if (value && !expected.includes(value)) {
      await selected.filter({ hasText: exact(value) })
        .locator('.kwaishop-goods-nexus-pc-select-selection-item-remove').click();
    }
  }
  const actual = (await selected.allInnerTexts()).map(value => value.trim()).filter(Boolean);
  if (actual.length !== expected.length || expected.some(value => !actual.includes(value))) {
    throw new Error(`面料材质不符：需要 ${expected.join('、')}，页面为 ${actual.join('、')}`);
  }
  log(`面料材质已核对：${actual.join('、')}`);
}

async function ensureMaterialComponents(page, components = []) {
  if (!components.length) return;
  const row = attributeRow(page, '材质成分(吊牌图识别)');
  if (!await row.count()) throw new Error('找不到材质成分多选区域');
  const selects = row.locator('.kwaishop-goods-nexus-pc-select-single');
  for (let index = 0; index < components.length; index++) {
    while (await selects.count() <= index) {
      await row.getByRole('button', { name: '添加材质' }).click();
    }
    const select = selects.nth(index);
    const current = (await select.locator('.kwaishop-goods-nexus-pc-select-selection-item').allInnerTexts())
      .map(text => text.trim()).filter(Boolean);
    if (current.includes(components[index])) continue;
    if (current.length) throw new Error(`材质成分第 ${index + 1} 项已有其他值：${current.join('、')}`);
    const combo = select.getByRole('combobox');
    await combo.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await select.locator('.kwaishop-goods-nexus-pc-select-selector').click({ timeout: 5000 });
    await combo.fill(components[index]);
    const option = select.locator('.kwaishop-goods-nexus-pc-select-item-option')
      .filter({ hasText: exact(components[index]) }).filter({ visible: true }).first();
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    const selected = await select.locator('.kwaishop-goods-nexus-pc-select-selection-item').allInnerTexts();
    if (!selected.some(text => text.trim() === components[index])) {
      throw new Error(`材质成分未写入：${components[index]}`);
    }
    log(`材质成分 ${index + 1}：${components[index]}`);
  }
}

async function ensureLabelImages(page, files) {
  if (!files.length) return;
  const row = attributeRow(page, '吊牌图（材质成分）');
  if (!await row.count()) { log('当前类目无吊牌图字段，已保留图片识别结果供人工核对'); return; }
  let count = Number((await row.innerText()).match(/上传图片\((\d+)\/5\)/)?.[1] || 0);
  if (count === files.length) { log(`吊牌图已有 ${count} 张，跳过上传`); return; }
  if (count !== 0) throw new Error(`吊牌图已有 ${count} 张，与方案 ${files.length} 张不一致`);
  while (count < files.length) {
    const trigger = row.getByRole('button', { name: new RegExp(`上传图片\\(${count}\\/5\\)`) }).first();
    count += await uploadViaPicker(page, trigger, files.slice(count));
    await row.getByRole('button', { name: new RegExp(`上传图片\\(${count}\\/5\\)`) })
      .first().waitFor({ state: 'visible', timeout: 15000 });
  }
  log(`吊牌图上传 ${count} 张`);
}

async function ensureDetailImage(page, files) {
  const row = attributeRow(page, '商品详情图');
  if (!await row.count()) throw new Error('找不到商品详情图区域');
  const count = Number((await row.innerText()).match(/已上传\s*(\d+)\/50\s*张/)?.[1] || 0);
  if (count === files.length) { log(`详情图已有 ${count} 张，跳过上传；请在方案审核时核对图片内容`); return; }
  const hasDecoratedPreview = await row.locator('img[src*="DECORATE_PREVIEW_IMAGE"]').count() > 0;
  if (count === files.length + 1 && hasDecoratedPreview) {
    log(`详情区包含 ${files.length} 张原图和 1 张装修预览图，跳过重复上传`);
    return;
  }
  if (count !== 0) throw new Error(`详情图已有 ${count} 张，请人工核对以免重复上传`);
  const input = row.locator('input[type="file"]').first();
  if (!await input.count()) throw new Error('找不到详情图上传入口');
  const multiple = await input.getAttribute('multiple') !== null;
  let sent = 0;
  while (sent < files.length) {
    const selected = multiple ? files.slice(sent) : files.slice(sent, sent + 1);
    await input.setInputFiles(selected);
    sent += selected.length;
    await row.getByText(new RegExp(`已上传\\s*${sent}\\/50\\s*张`)).first()
      .waitFor({ state: 'visible', timeout: 15000 });
  }
  log('详情图已上传');
}

async function ensureSizes(page, facts, allowResetSkus) {
  const sizes = facts.sizes || [];
  if (!sizes.length) return;
  const template = facts.sizeTemplate || '中国码';
  const templateButton = page.getByRole('button', { name: template });
  const switchDialog = page.getByRole('dialog').filter({ hasText: '确定切换分组吗' });
  const sizeRow = size => page.locator('div[style="display: flex; gap: 4px;"]')
    .filter({ hasText: exact(size) });
  const allSizes = ['均码', 'XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL',
    ...Array.from({ length: 20 }, (_, index) => String(index + 23))];
  const checkedSizes = [];
  for (const size of allSizes) {
    const row = sizeRow(size);
    if (await row.count() && await row.getByRole('checkbox').isChecked()) checkedSizes.push(size);
  }
  let outcome = 'sizes';
  if (await switchDialog.isVisible().catch(() => false)) {
    outcome = 'dialog';
  } else if (checkedSizes.length !== sizes.length || !sizes.every(size => checkedSizes.includes(size))) {
    try {
      await templateButton.click({ timeout: 2500 });
    } catch (error) {
      const colorPanel = page.locator('.kwaishop-goods-nexus-pc-dropdown')
        .filter({ has: page.locator('[class*="color-panel-wrap"]') }).filter({ visible: true });
      if (!await colorPanel.count()) throw error;
      await page.keyboard.press('Escape');
      await templateButton.click({ timeout: 5000 });
    }
    outcome = await Promise.race([
      switchDialog.waitFor({ state: 'visible', timeout: FORM_TIMEOUT }).then(() => 'dialog'),
      sizeRow(sizes[0]).first().waitFor({ state: 'visible', timeout: FORM_TIMEOUT }).then(() => 'sizes')
    ]);
  }
  if (outcome === 'dialog') {
    if (!allowResetSkus || facts.priceYuan == null || facts.stockPerSku == null) {
      throw new Error('切换尺码模板会清空已有 SKU，且方案未授权或缺少完整的重建价格库存');
    }
    await switchDialog.getByRole('button', { name: '确 认' }).click();
    await switchDialog.waitFor({ state: 'hidden', timeout: FORM_TIMEOUT });
    log('已确认切换尺码分组；后续将重建尺码及 SKU 价格库存');
  }
  await sizeRow(sizes[0]).first().waitFor({ state: 'visible', timeout: FORM_TIMEOUT });
  for (const size of allSizes) {
    if (sizes.includes(size)) continue;
    const row = sizeRow(size);
    if (!await row.count() || !await row.getByRole('checkbox').isChecked()) continue;
    if (!allowResetSkus) throw new Error(`页面已有计划外尺码 ${size}，未授权清除原 SKU`);
    await row.getByRole('checkbox').uncheck();
  }
  for (const size of sizes) {
    const row = sizeRow(size);
    if (!await row.count()) throw new Error(`尺码模板 ${template} 没有 ${size}`);
    await row.getByRole('checkbox').check();
    const remark = facts.sizeRemarks?.[size] ?? '';
    const input = row.getByPlaceholder('请输入备注');
    if (await input.count() !== 1) throw new Error(`尺码 ${size} 找不到唯一的备注输入框`);
    const currentRemark = await input.inputValue();
    if (currentRemark !== remark) {
      if (currentRemark && !allowResetSkus) throw new Error(`尺码 ${size} 已有方案外备注，未授权清除`);
      await input.fill(remark);
    }
    if (await input.inputValue() !== remark) throw new Error(`尺码 ${size} 备注未写入：${remark}`);
  }
  if (facts.sizeAdvice) await page.getByRole('radio', { name: facts.sizeAdvice }).check();
  const stopChart = page.getByRole('button', { name: '停用尺码表' });
  if (await stopChart.count()) {
    await stopChart.click();
    const dialog = page.getByRole('dialog').filter({ hasText: '确定停用尺码表吗' });
    await dialog.getByRole('button', { name: '停 用' }).click();
  }
  log(`尺码备注：${sizes.map(size => `${size} ${facts.sizeRemarks?.[size] || ''}`.trim()).join('、')}`);
}

async function ensureColors(page, facts) {
  const colors = facts.colors || (facts.color ? [facts.color] : []);
  for (const color of colors) {
    let inputs = page.getByPlaceholder('请选择或输入规格值');
    let values = await inputs.evaluateAll(els => els.map(el => el.value));
    if (values.includes(color)) {
      const existing = inputs.nth(values.indexOf(color));
      if (await existing.evaluate(el => document.activeElement === el)) await existing.press('Enter');
      log(`颜色已是：${color}`);
      continue;
    }
    let empty = values.findIndex(value => !value);
    if (empty < 0) {
      const add = page.getByRole('button', { name: /添加规格值|新增规格值/ }).first();
      if (!await add.isVisible().catch(() => false)) {
        throw new Error(`找不到新增颜色“${color}”的空输入框或添加按钮`);
      }
      await add.click();
      inputs = page.getByPlaceholder('请选择或输入规格值');
      values = await inputs.evaluateAll(els => els.map(el => el.value));
      empty = values.findIndex(value => !value);
      if (empty < 0) throw new Error(`点击添加按钮后仍找不到颜色“${color}”输入框`);
    }
    const input = inputs.nth(empty);
    await input.fill(color);
    await input.press('Enter');
    if (await input.inputValue() !== color) throw new Error(`颜色 ${color} 未成功写入`);
    log(`颜色：${color}`);
  }
  const actual = await page.getByPlaceholder('请选择或输入规格值')
    .evaluateAll(els => els.map(el => el.value).filter(Boolean));
  if (actual.length !== colors.length || !colors.every(color => actual.includes(color))) {
    throw new Error(`颜色规格与方案不一致：页面 ${actual.join('、')}；方案 ${colors.join('、')}`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
}

async function ensurePriceStock(page, facts) {
  if (facts.priceYuan == null || facts.stockPerSku == null) return [];
  const batchButton = page.getByRole('button', { name: '批量设置' });
  if (await batchButton.count()) {
    const batch = page.getByRole('spinbutton', { name: '请输入' });
    await batch.nth(0).fill(String(facts.stockPerSku));
    await batch.nth(1).fill(String(facts.priceYuan));
    await batchButton.click();
  } else {
    const skuInputs = page.locator('input[role="spinbutton"][skukey]');
    if (await skuInputs.count() !== 2) throw new Error('单规格商品找不到唯一的库存与价格输入框');
    await skuInputs.nth(0).fill(String(facts.stockPerSku));
    await skuInputs.nth(1).fill(String(facts.priceYuan));
    const stock = await skuInputs.nth(0).inputValue();
    const price = await skuInputs.nth(1).inputValue();
    if (stock !== String(facts.stockPerSku) || price !== String(facts.priceYuan)) {
      throw new Error('单规格商品价格库存未写入');
    }
    const sku = await skuInputs.nth(0).getAttribute('skukey');
    log(`各 SKU 库存 ${facts.stockPerSku}，价格 ${facts.priceYuan} 元`);
    return [{ sku, stock, price }];
  }
  const holder = page.locator('.ant-table-tbody-virtual-holder').first();
  const seen = new Map();
  const originalTop = await holder.count() ? await holder.evaluate(el => el.scrollTop) : 0;
  const positions = await holder.count() ? [0, await holder.evaluate(el => el.scrollHeight)] : [0];
  for (const top of positions) {
    if (await holder.count()) {
      await holder.evaluate((el, position) => { el.scrollTop = position; }, top);
      await page.waitForTimeout(80);
    }
    const visible = await page.locator('input[role="spinbutton"][stock][price]')
      .evaluateAll(els => els.map(el => ({ sku: el.getAttribute('skukey'),
        stock: el.getAttribute('stock'), price: el.getAttribute('price') })));
    for (const row of visible) seen.set(row.sku, row);
  }
  if (await holder.count()) await holder.evaluate((el, position) => { el.scrollTop = position; }, originalTop);
  const rows = [...seen.values()];
  const expected = (facts.colors || (facts.color ? [facts.color] : [])).length * (facts.sizes || []).length;
  const skuCount = rows.length;
  if (expected && skuCount !== expected) throw new Error(`SKU 数量不符：页面 ${skuCount}，方案 ${expected}`);
  if (!rows.length || rows.some(row => row.stock !== String(facts.stockPerSku)
    || row.price !== String(facts.priceYuan))) {
    throw new Error('批量价格库存未写入所有 SKU');
  }
  log(`各 SKU 库存 ${facts.stockPerSku}，价格 ${facts.priceYuan} 元`);
  return rows;
}

async function readSavedHandcard(page, plan, stampText, skuRows, pending) {
  const title = await page.getByRole('textbox', { name: /最多输入30个汉字/ }).inputValue();
  const sellingPoint = await page.getByRole('textbox', { name: /支持4-12个汉字/ }).inputValue();
  const attribute = async label => (await attributeRow(page, label)
    .locator('.kwaishop-goods-nexus-pc-select-selection-item').allInnerTexts())
    .map(value => value.trim()).filter(Boolean).join('、');
  const material = await attribute('面料材质');
  const composition = await attribute('成分含量');
  if (plan.facts.materialComposition) {
    const expected = plan.facts.materialComposition.map(item => item.name);
    const actual = material.split('、').filter(Boolean);
    const expectedRange = plan.facts.attributes['成分含量'];
    if (actual.length !== expected.length || expected.some(value => !actual.includes(value))
      || (expectedRange === '95%以上' ? !/95%.*以上/.test(composition) : composition !== expectedRange)) {
      throw new Error('草稿已保存，但面料材质或成分含量与方案不一致，手卡未生成');
    }
  }
  const colors = await page.getByPlaceholder('请选择或输入规格值')
    .evaluateAll(elements => elements.map(element => element.value).filter(Boolean));
  const sizes = [];
  const sizeRemarks = {};
  for (const size of [...plan.facts.sizes]) {
    const row = page.locator('div[style="display: flex; gap: 4px;"]').filter({ hasText: exact(size) });
    if (!await row.count() || !await row.getByRole('checkbox').isChecked()) continue;
    sizes.push(size);
    sizeRemarks[size] = await row.getByPlaceholder('请输入备注').inputValue();
  }
  const presale = page.locator('.DeliveryTimeMode-radio input[type="radio"][value="presale"]');
  const presaleDays = await presale.isChecked()
    ? Number(await page.locator('.DeliveryTimeMode-preSale input[role="spinbutton"]').inputValue())
    : null;
  const prices = [...new Set(skuRows.map(row => row.price))];
  const stocks = [...new Set(skuRows.map(row => row.stock))];
  const expectedColors = plan.facts.colors || (plan.facts.color ? [plan.facts.color] : []);
  if (title !== plan.copy.title || sellingPoint !== plan.copy.sellingPoint
    || JSON.stringify(colors) !== JSON.stringify(expectedColors)
    || JSON.stringify(sizes) !== JSON.stringify(plan.facts.sizes)
    || prices.length !== 1 || stocks.length !== 1
    || presaleDays !== plan.facts.presaleDays) {
    throw new Error('草稿已保存，但页面回读与方案不一致，手卡未生成');
  }
  const savedAt = stampText.replace(/^最后保存于\s*/, '').trim();
  return {
    saved: true, savedAt, sourceUrl: page.url(),
    title, sellingPoint, image: plan.images.main[0],
    styleNumber: plan.facts.styleNumber || null,
    brand: await attribute('品牌'), material, composition,
    compositionExact: plan.facts.materialComposition ? exactComposition(plan.facts.materialComposition) : null,
    garmentLength: await attribute('衣长') || await attribute('裤长'),
    garmentLengthLabel: plan.categoryPath?.[1] === '裤子' ? '裤长' : '衣长',
    colors, sizes, sizeRemarks,
    priceYuan: plan.facts.handcardPriceYuan ?? null,
    shopPriceYuan: Number(prices[0]), stockPerSku: Number(stocks[0]), presaleDays,
    merchant: plan.facts.handcardMerchant || '',
    tagPriceYuan: null, commission: null, pending,
  };
}

async function ensurePresale(page, days) {
  if (days == null) return;
  const radio = page.locator('.DeliveryTimeMode-radio input[type="radio"][value="presale"]');
  if (await radio.count() !== 1) throw new Error('找不到唯一的“全部预售”发货模式');
  const warning = page.getByRole('dialog').filter({ hasText: '若有现货库存' });
  async function confirmPresaleWarning() {
    if (!await warning.isVisible().catch(() => false)) return false;
    await warning.getByRole('button', { name: '继续设置预售' }).click();
    await warning.waitFor({ state: 'hidden', timeout: FORM_TIMEOUT });
    return true;
  }
  await confirmPresaleWarning();
  if (!await radio.isChecked()) {
    await page.getByText('全部预售', { exact: true }).click();
    if (!await radio.isChecked() && !await warning.isVisible().catch(() => false)) {
      await warning.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    }
    await confirmPresaleWarning();
  }
  if (!await radio.isChecked()) {
    await page.waitForFunction(() => document.querySelector('.DeliveryTimeMode-radio input[value="presale"]')?.checked,
      null, { timeout: 3000 }).catch(() => {});
  }
  if (!await radio.isChecked()) throw new Error('“全部预售”未成功选中');
  const input = page.locator('.DeliveryTimeMode-preSale input[role="spinbutton"]');
  if (await input.count() !== 1) throw new Error('找不到唯一的预售发货天数输入框');
  await input.fill(String(days));
  await input.press('Tab');
  if (await input.inputValue() !== String(days)) {
    throw new Error(`预售发货天数未写入：${days}`);
  }
  log(`发货时效：全部预售，付款后 ${days} 天内发货`);
}

async function ensureShippingTemplate(page, name) {
  if (!name) return;
  await dismissKnownGuidance(page);
  const row = page.locator('.kwaishop-goods-nexus-pc-formily-item')
    .filter({ has: page.locator('[data-id$="-expressTemplate"]') }).first();
  if (await row.count() !== 1) throw new Error('找不到唯一的运费模板字段');
  const selected = row.locator('.kwaishop-goods-nexus-pc-select-selection-item');
  if ((await selected.innerText().catch(() => '')).trim() !== name) {
    const item = page.locator('.kwaishop-goods-nexus-pc-select-item-option')
      .filter({ hasText: exact(name) }).filter({ visible: true }).first();
    if (!await item.isVisible().catch(() => false)) {
      await row.locator('.kwaishop-goods-nexus-pc-select-selector').click();
    }
    await item.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
      throw new Error(`运费模板列表中找不到“${name}”，已停止`);
    });
    const label = item.locator('label');
    if (await label.count()) await label.click();
    else await item.click();
  }
  if ((await selected.innerText().catch(() => '')).trim() !== name) {
    throw new Error(`运费模板未成功选择“${name}”`);
  }
  log(`运费模板：${name}`);
}

async function applyPlan(plan, endpoint) {
  validateApprovedPlan(plan);
  const mainImages = await prepareMainImages(plan.images.main);
  const runtimePending = [...(plan.pending || [])];
  const { browser, page } = await connectToProductTab(endpoint, plan);
  try {
    await resolveExistingDraft(page, plan);
    await page.getByRole('button', { name: '下一步，完善商品信息' })
      .or(page.getByRole('textbox', { name: /最多输入30个汉字/ }))
      .first().waitFor({ state: 'visible', timeout: FORM_TIMEOUT });
    if (!plan.draftId && !plan.resumeUnsaved) {
      const title = page.getByRole('textbox', { name: /最多输入30个汉字/ });
      if (await title.count() && (await title.inputValue()).trim()) {
        throw new Error('新建页面已有商品标题，已停止以防覆盖未保存内容');
      }
    }
    if (await page.getByRole('dialog').filter({ hasText: '装修组件' }).isVisible().catch(() => false)) {
      throw new Error('装修商详编辑器仍打开，请关闭后重试；脚本不会写入商详文字');
    }
    const staleInvalidImage = !plan.draftId && plan.allowResetUnsaved === true
      && (await page.locator('body').innerText()).includes('图片长宽比需1:1');
    if (staleInvalidImage) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /上传图片\(0\/9\)/ }).waitFor({ state: 'visible' });
      log('已重置上次失败的未保存表单与裁剪弹窗');
    }
    if (await page.getByRole('button', { name: '下一步，完善商品信息' }).count()) {
      await ensureMainImages(page, mainImages);
      await ensureCategory(page, plan.categoryPath, plan);
    }
    await dismissKnownGuidance(page);
    await page.getByRole('textbox', { name: /最多输入30个汉字/ }).fill(plan.copy.title);
    await page.getByRole('textbox', { name: /支持2~10个字/ }).fill(plan.copy.shortTitle);
    log('标题与短标题已填写');
    for (const [label, rawValue] of Object.entries(plan.facts.attributes || {})) {
      for (const value of (Array.isArray(rawValue) ? rawValue : [rawValue])) {
        if (value && !await selectAttribute(page, label, value)) {
          runtimePending.push(`${label}：${value}（后台无可选项）【待人工核对】`);
        }
      }
    }
    await ensureExactFabric(page, plan.facts.attributes?.['面料材质']);
    await ensureMaterialComponents(page, plan.facts.materialComponents);
    if (plan.facts.skipLabelUpload && plan.images.label?.length) {
      log('水洗唛数字与商家确认值不一致，原唛仅作内部核对依据，不上传至商品页面');
    } else {
      await ensureLabelImages(page, plan.images.label || []);
    }
    log('商品属性与吊牌图已处理');
    await ensureMainImages(page, mainImages);
    await ensureDetailImage(page, plan.images.detail);
    await page.getByRole('textbox', { name: /支持4-12个汉字/ }).fill(plan.copy.sellingPoint);
    log('卖点与商品详情图已填写；不写装修商详文字');
    await ensureColors(page, plan.facts);
    await ensureSizes(page, plan.facts, !plan.draftId || plan.allowResetSkus === true);
    await ensureShippingTemplate(page, plan.facts.shippingTemplate);
    await ensurePresale(page, plan.facts.presaleDays);
    const verifiedSkus = await ensurePriceStock(page, plan.facts);
    for (const [label, rawValue] of Object.entries(plan.facts.attributes || {})) {
      for (const rawItem of (Array.isArray(rawValue) ? rawValue : [rawValue])) {
        const value = label === '服装版型' && rawItem === '常规' ? '常规款' : rawItem;
        if (!value) continue;
        const pending = `${label}：${value}（后台无可选项）【待人工核对】`;
        if (!await selectedAttribute(attributeRow(page, label), value).count()) {
          log(`${label}：${value} 被页面后续预填清空，保存前重新填写`);
          if (!await selectAttribute(page, label, value)) {
            if (!runtimePending.includes(pending)) runtimePending.push(pending);
            continue;
          }
        }
        const pendingIndex = runtimePending.indexOf(pending);
        if (pendingIndex >= 0) runtimePending.splice(pendingIndex, 1);
      }
    }
    await ensureExactFabric(page, plan.facts.attributes?.['面料材质']);
    await ensureMaterialComponents(page, plan.facts.materialComponents);
    if (plan.facts.immediateListing === true) {
      const on = page.getByRole('radio', { name: '上架', exact: true });
      if (await on.count() !== 1) throw new Error('找不到唯一的“商品立即上架：上架”选项');
      await on.check();
      if (!await on.isChecked()) throw new Error('“商品立即上架：上架”未选中');
      log('商品立即上架：上架（仅保存草稿，未提交审核）');
    }
    await page.getByRole('button', { name: '填写检查' }).click();
    const errorTab = page.getByRole('tab', { name: '填写错误', exact: true });
    await errorTab.click();
    const errorPanelId = await errorTab.getAttribute('aria-controls');
    if (!errorPanelId) throw new Error('填写错误标签未关联校验面板');
    const errorPanel = page.locator(`[role="tabpanel"][id="${errorPanelId}"]`);
    await errorPanel.waitFor({ state: 'visible', timeout: 3000 });
    const errors = (await errorPanel.innerText()).trim();
    if (errors !== '无待处理项') {
      log(`填写检查：${errors || '校验面板为空'}`);
      throw new Error('填写检查未通过，未保存草稿');
    }
    log('填写检查：无待处理项');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    const stamp = page.getByText(/最后保存于/).first();
    await stamp.waitFor({ state: 'visible', timeout: 15000 });
    log('已保存草稿，未提交审核或发布');
    const timestamp = await stamp.innerText();
    let handcardData;
    let handcardReadError;
    try {
      handcardData = await readSavedHandcard(page, plan, timestamp, verifiedSkus, runtimePending);
      log('已从保存后的页面核对手卡字段');
    } catch (error) {
      handcardReadError = error.message;
      log(`草稿已保存，手卡回读失败：${handcardReadError}`);
    }
    return { saved: true, timestamp, errors, pending: runtimePending,
      handcardData, handcardReadError };
  } catch (error) {
    const dir = path.resolve('run-logs');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `failure-${Date.now()}.png`);
    const screenshotSaved = await page.screenshot({ path: file, fullPage: false, timeout: 5000 })
      .then(() => true).catch(() => false);
    throw new Error(`${error.message}\n已停止，${screenshotSaved ? `页面截图：${file}` : '截图未能保存'}`);
  } finally {
    await browser.close();
  }
}

module.exports = { applyPlan, readSavedHandcard };
