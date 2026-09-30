const fs = require('node:fs');
const path = require('node:path');
const { compositionRange } = require('./composition.cjs');

const SITE = 'https://s.kwaixiaodian.com';
const PENDING = '【待人工核对】';
const SHOP_PRICE_YUAN = 9999;
function stockForHandcardPrice(priceYuan) {
  if (priceYuan == null) return 1000;
  ensure(Number.isFinite(priceYuan) && priceYuan > 0, '手卡价格必须为正数');
  return 1000 + Math.trunc(priceYuan);
}
const CLOTHING_RULES = Object.freeze({
  brand: '无品牌',
  season: '2026年冬季',
  presaleDays: 15,
  shippingTemplate: '全国包邮新疆西藏',
  immediateListing: true,
  priceYuan: SHOP_PRICE_YUAN,
  stockPerSku: 1000,
  sizes: Object.freeze(['S', 'M', 'L', 'XL']),
  extraTopSizes: Object.freeze(['2XL', '3XL', '4XL', '5XL', '均码']),
  pantsSizes: Object.freeze(['26', '27', '28', '29', '30']),
  sizeRemarks: Object.freeze({ S: '70-90', M: '90-100', L: '100-120', XL: '120-140' }),
  sizeAdvice: '卡码拍小',
  noLabelFabric: '涤纶(聚酯纤维)',
  noLabelComposition: '95%以上'
});
const CLOTHING_CATEGORIES = new Set(['女装', '男装', '童装/婴儿装/亲子装', '内衣/家居服/袜子']);

function normalizeCategoryPath(categoryPath) {
  return categoryPath?.[0] === '女装' && categoryPath?.[1] === '内搭'
    ? ['女装', 'T恤'] : categoryPath;
}

function displayUnits(text) {
  return Array.from(String(text)).reduce((total, c) => total + (/^[\x00-\x7f]$/.test(c) ? 1 : 2), 0);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeClothingFacts(categoryPath, source = {}, hasWashLabel = false, options = {}) {
  ensure(source && typeof source === 'object' && !Array.isArray(source), 'facts 必须是对象');
  ensure(source.attributes == null || (typeof source.attributes === 'object' && !Array.isArray(source.attributes)),
    'facts.attributes 必须是对象');
  const facts = { ...source, attributes: { ...(source.attributes || {}) } };
  if (!CLOTHING_CATEGORIES.has(categoryPath?.[0])) return facts;
  const fixed = [
    ['priceYuan', CLOTHING_RULES.priceYuan],
    ['stockPerSku', stockForHandcardPrice(facts.handcardPriceYuan)],
    ['presaleDays', CLOTHING_RULES.presaleDays],
    ['shippingTemplate', CLOTHING_RULES.shippingTemplate],
    ['immediateListing', CLOTHING_RULES.immediateListing],
    ['sizeAdvice', CLOTHING_RULES.sizeAdvice]
  ];
  for (const [key, value] of fixed) {
    ensure(facts[key] == null || facts[key] === value,
      `${key} 与服装统一规则冲突：应为 ${value}`);
    facts[key] = value;
  }
  ensure(facts.sizes == null || Array.isArray(facts.sizes), 'facts.sizes 必须是数组');
  const isPants = categoryPath?.[1] === '裤子';
  const allowedSizes = isPants ? [...CLOTHING_RULES.pantsSizes, ...CLOTHING_RULES.sizes, ...CLOTHING_RULES.extraTopSizes]
    : [...CLOTHING_RULES.sizes, ...CLOTHING_RULES.extraTopSizes];
  const sizes = facts.sizes?.map(value => String(value).trim().toUpperCase())
    || [...(isPants ? CLOTHING_RULES.pantsSizes : CLOTHING_RULES.sizes)];
  ensure(sizes.length > 0 && new Set(sizes).size === sizes.length
    && sizes.every(size => allowedSizes.includes(size)),
  `sizes 只能是不重复的 ${allowedSizes.join('、')} 子集`);
  facts.sizes = sizes;
  const expectedRemarks = isPants ? {} : Object.fromEntries(sizes
    .filter(size => CLOTHING_RULES.sizeRemarks[size] != null)
    .map(size => [size, CLOTHING_RULES.sizeRemarks[size]]));
  ensure(facts.sizeRemarks == null || (Object.keys(facts.sizeRemarks).length === Object.keys(expectedRemarks).length
    && Object.keys(expectedRemarks).every(size => facts.sizeRemarks[size] === expectedRemarks[size])),
  'sizeRemarks 与所选尺码的统一规则冲突');
  facts.sizeRemarks = expectedRemarks;
  for (const [key, value] of [
    ['品牌', CLOTHING_RULES.brand],
    ['上市年份季节', CLOTHING_RULES.season]
  ]) {
    ensure(facts.attributes[key] == null || facts.attributes[key] === value,
      `${key} 与服装统一规则冲突：应为 ${value}`);
    facts.attributes[key] = value;
  }
  facts.attributes['厚度'] ||= '常规';
  if (facts.materialComposition != null) {
    ensure(Array.isArray(facts.materialComposition) && facts.materialComposition.length > 0
      && facts.materialComposition.every(item => item && typeof item.name === 'string' && item.name.trim()
        && Number.isFinite(item.percent) && item.percent > 0 && item.percent <= 100)
      && new Set(facts.materialComposition.map(item => item.name)).size === facts.materialComposition.length,
    'materialComposition 必须是不重复的材质及有效百分比');
    ensure(Math.abs(facts.materialComposition.reduce((sum, item) => sum + item.percent, 0) - 100) < 0.001,
      'materialComposition 百分比合计必须为 100%');
    facts.attributes['面料材质'] = facts.materialComposition.map(item => item.name);
    facts.attributes['成分含量'] = compositionRange(facts.materialComposition);
  }
  if (isPants) {
    facts.attributes['腰型'] ||= '中腰';
    if (facts.attributes['弹力'] == null) facts.attributes['弹力'] = '无弹';
  }
  if (!isPants) {
    if (categoryPath?.[1] === 'T恤') {
      const fit = { '常规': '标准型', '常规款': '标准型', '修身': '修身型', '宽松': '宽松型' };
      facts.attributes['服装版型'] = fit[facts.attributes['服装版型']] || facts.attributes['服装版型'];
      if (!options.deferFitDefault) facts.attributes['服装版型'] ||= '标准型';
    } else {
      if (facts.attributes['服装版型'] === '常规') facts.attributes['服装版型'] = '常规款';
      if (!options.deferFitDefault) facts.attributes['服装版型'] ||= '常规款';
    }
  }
  if (!hasWashLabel && facts.deferMaterial !== true && facts.materialComposition == null) {
    for (const [key, value] of [
      ['面料材质', CLOTHING_RULES.noLabelFabric],
      ['成分含量', CLOTHING_RULES.noLabelComposition]
    ]) {
      ensure(facts.attributes[key] == null || facts.attributes[key] === value,
        `无水洗唛时${key}与服装统一规则冲突：应为 ${value}`);
      facts.attributes[key] = value;
    }
  }
  return facts;
}

function resolveImages(input, sourcePath) {
  const root = path.dirname(path.resolve(sourcePath));
  const images = input.images || {};
  const result = {};
  for (const kind of ['main', 'detail', 'label']) {
    const values = images[kind] || [];
    ensure(Array.isArray(values), `images.${kind} 必须是数组`);
    result[kind] = values.map(value => {
      const full = path.resolve(root, value);
      ensure(fs.existsSync(full), `图片不存在：${full}`);
      ensure(/\.(jpe?g|png)$/i.test(full), `仅支持 jpg/jpeg/png：${full}`);
      ensure(fs.statSync(full).size <= 2 * 1024 * 1024, `图片超过 2MB：${full}`);
      return full;
    });
  }
  ensure(result.main.length > 0, '至少提供一张商品主图');
  if (!result.detail.length) result.detail = [...result.main];
  return result;
}

function pendingFields(input) {
  const facts = input.facts || {};
  const missing = [];
  if (!facts.attributes?.['面料材质']) missing.push(`面料材质${PENDING}`);
  if (!facts.attributes?.['成分含量']) missing.push(`成分含量${PENDING}`);
  if (!(facts.sizes || []).length) missing.push(`可售尺码${PENDING}`);
  if (!facts.sizeAdvice && (facts.sizes || []).length) missing.push(`尺码偏大或偏小${PENDING}`);
  if (facts.priceYuan == null) missing.push(`售价${PENDING}`);
  if (facts.stockPerSku == null) missing.push(`库存${PENDING}`);
  return missing;
}

function validateSource(input, sourcePath) {
  ensure(input && typeof input === 'object', '输入必须是 JSON 对象');
  ensure(Array.isArray(input.categoryPath) && input.categoryPath.length >= 2,
    'categoryPath 需要至少两级类目');
  const images = resolveImages(input, sourcePath);
  const facts = input.facts || {};
  ensure(facts.attributes && typeof facts.attributes === 'object', 'facts.attributes 必须是对象');
  if (facts.priceYuan != null) ensure(Number.isFinite(facts.priceYuan) && facts.priceYuan > 0,
    'priceYuan 必须是正数');
  if (facts.stockPerSku != null) ensure(Number.isInteger(facts.stockPerSku) && facts.stockPerSku >= 0,
    'stockPerSku 必须是非负整数');
  if (facts.presaleDays != null) ensure(Number.isInteger(facts.presaleDays) && facts.presaleDays >= 3 && facts.presaleDays <= 20,
    'presaleDays 必须是 3～20 天的整数');
  if (facts.sizes != null) ensure(Array.isArray(facts.sizes), 'facts.sizes 必须是数组');
  if (facts.colors != null) {
    ensure(Array.isArray(facts.colors) && facts.colors.length > 0
      && facts.colors.every(value => typeof value === 'string' && value.trim())
      && new Set(facts.colors).size === facts.colors.length,
    'facts.colors 必须是非空且不重复的颜色数组');
  }
  if (facts.materialComponents != null) ensure(Array.isArray(facts.materialComponents)
    && facts.materialComponents.length > 0
    && facts.materialComponents.every(value => typeof value === 'string' && value.trim())
    && new Set(facts.materialComponents).size === facts.materialComponents.length,
  'facts.materialComponents 必须是不重复的材质名称数组');
  if (facts.sizeAdvice != null) ensure(['卡码拍大', '卡码拍小'].includes(facts.sizeAdvice),
    'sizeAdvice 只能是“卡码拍大”或“卡码拍小”');
  ensure(facts.deferMaterial == null || facts.deferMaterial === true,
    'deferMaterial 只能设为 true，表示材质留待人工补充');
  return { images, pending: pendingFields(input) };
}

function validateCopy(copy) {
  for (const key of ['title', 'shortTitle', 'sellingPoint']) {
    ensure(typeof copy?.[key] === 'string' && copy[key].trim(), `缺少文案 ${key}`);
  }
  ensure(displayUnits(copy.title) <= 60, '商品标题超过平台的 60 字符限制');
  ensure(displayUnits(copy.shortTitle) >= 4 && displayUnits(copy.shortTitle) <= 20,
    '商品短标题应为 2～10 个汉字或等长字符');
  ensure(displayUnits(copy.sellingPoint) >= 8 && displayUnits(copy.sellingPoint) <= 24,
    '商品卖点应为 4～12 个汉字或等长字符');
  ensure(!/(最[佳好低高强]|第一|顶级|全网唯一|100%保证|永久)/.test(Object.values(copy).join(' ')),
    '文案中可能含极限词，请人工修改');
}

function createPlan(input, sourcePath, generated = {}) {
  const categoryPath = normalizeCategoryPath(input.categoryPath);
  const sourceFacts = structuredClone(input.facts || {});
  if (sourceFacts.priceYuan != null) {
    ensure(Number.isFinite(sourceFacts.priceYuan) && sourceFacts.priceYuan > 0, '输入价格必须为正数');
    if (sourceFacts.priceYuan !== SHOP_PRICE_YUAN) {
      ensure(sourceFacts.handcardPriceYuan == null || sourceFacts.handcardPriceYuan === sourceFacts.priceYuan,
        '输入价格与手卡价格不一致');
      sourceFacts.handcardPriceYuan = sourceFacts.priceYuan;
    }
  }
  sourceFacts.priceYuan = SHOP_PRICE_YUAN;
  if (sourceFacts.handcardPriceYuan != null) {
    ensure(Number.isFinite(sourceFacts.handcardPriceYuan) && sourceFacts.handcardPriceYuan > 0,
      '手卡价格必须为正数');
  }
  sourceFacts.stockPerSku = stockForHandcardPrice(sourceFacts.handcardPriceYuan);
  sourceFacts.attributes ||= {};
  if (!sourceFacts.attributes['服装版型']) {
    const imageFit = generated.observed?.fit;
    if (imageFit === '修身' || imageFit === '宽松') sourceFacts.attributes['服装版型'] = imageFit;
  }
  const facts = normalizeClothingFacts(categoryPath, sourceFacts, !!input.images?.label?.length);
  const { images, pending } = validateSource({ ...input, categoryPath, facts }, sourcePath);
  ensure(input.pendingNotes == null || (Array.isArray(input.pendingNotes)
    && input.pendingNotes.every(note => typeof note === 'string' && note.trim())),
  'pendingNotes 必须是非空字符串数组');
  pending.push(...(input.pendingNotes || []));
  const copy = { ...generated, ...(input.copyOverrides || {}) };
  if (facts.styleNumber != null) {
    ensure(typeof facts.styleNumber === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(facts.styleNumber),
      'styleNumber 只能包含字母、数字或连字符，最多20位');
    if (typeof copy.title === 'string' && !copy.title.startsWith(facts.styleNumber)) {
      copy.title = `${facts.styleNumber} ${copy.title}`;
    }
  }
  validateCopy(copy);
  return {
    schemaVersion: 1,
    destination: SITE,
    mode: 'draft-only',
    review: { approved: false, note: '请核对图片识别、文案及服装统一规则，再改为 true' },
    categoryPath,
    images,
    facts,
    copy,
    observed: generated.observed || {},
    pending,
    draftId: input.draftId || null
  };
}

function validateApprovedPlan(plan) {
  ensure(plan?.schemaVersion === 1 && plan.destination === SITE && plan.mode === 'draft-only',
    '方案格式或目标站点不符');
  ensure(plan.review?.approved === true, '请先审核方案并将 review.approved 改为 true');
  ensure(plan.draftConflictChoice == null || (plan.draftConflictChoice === 'new' && !plan.draftId),
    'draftConflictChoice 仅可用于新商品并设置为 new');
  ensure(plan.resumeUnsaved == null || (plan.resumeUnsaved === true && !plan.draftId),
    'resumeUnsaved 仅可用于新商品未保存表单');
  ensure(Array.isArray(plan.images?.main) && plan.images.main.length > 0, '缺少商品主图');
  for (const list of Object.values(plan.images)) {
    if (Array.isArray(list)) for (const image of list) ensure(fs.existsSync(image), `图片不存在：${image}`);
  }
  validateCopy(plan.copy);
  const f = plan.facts || {};
  ensure(f.priceYuan === SHOP_PRICE_YUAN, `商品链接售价必须为 ${SHOP_PRICE_YUAN} 元`);
  if (f.handcardPriceYuan != null) {
    ensure(Number.isFinite(f.handcardPriceYuan) && f.handcardPriceYuan > 0, '手卡价格必须为正数');
  }
  ensure(f.stockPerSku === stockForHandcardPrice(f.handcardPriceYuan),
    '库存必须等于 1000 加手卡价格的整数部分');
  ensure(f.deferMaterial == null || f.deferMaterial === true,
    'deferMaterial 只能设为 true，表示材质留待人工补充');
  ensure(f.skipLabelUpload == null || (f.skipLabelUpload === true && plan.images?.label?.length),
    'skipLabelUpload 仅可用于已提供标签图的商品');
  if (f.styleNumber != null) {
    ensure(typeof f.styleNumber === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(f.styleNumber),
      '无效款号');
    ensure(plan.copy.title.startsWith(f.styleNumber), '商品标题未以款号开头');
  }
  const normalized = normalizeClothingFacts(plan.categoryPath, f, !!plan.images?.label?.length);
  if (CLOTHING_CATEGORIES.has(plan.categoryPath?.[0])) {
    for (const key of ['priceYuan', 'stockPerSku', 'presaleDays', 'shippingTemplate', 'immediateListing']) {
      ensure(f[key] === normalized[key], `方案缺少服装统一规则：${key}`);
    }
    ensure(JSON.stringify(f.sizes) === JSON.stringify(normalized.sizes),
      '方案尺码不符合服装统一规则');
    ensure(JSON.stringify(f.sizeRemarks) === JSON.stringify(normalized.sizeRemarks),
      '方案尺码备注不符合服装统一规则');
    for (const key of ['品牌', '上市年份季节',
      ...(plan.categoryPath?.[1] === '裤子' ? [] : ['服装版型'])]) {
      ensure(f.attributes?.[key] === normalized.attributes[key],
        `方案缺少服装统一规则：${key}`);
    }
    ensure(f.sizeAdvice === normalized.sizeAdvice, '方案尺码建议不符合服装统一规则');
    if (f.materialComposition != null) {
      ensure(JSON.stringify(f.attributes?.['面料材质']) === JSON.stringify(normalized.attributes['面料材质'])
        && f.attributes?.['成分含量'] === normalized.attributes['成分含量'],
      '面料材质或成分含量与 materialComposition 不一致');
    } else if (!plan.images?.label?.length && f.deferMaterial !== true) {
      for (const key of ['面料材质', '成分含量']) {
        ensure(f.attributes?.[key] === normalized.attributes[key],
          `无水洗唛方案缺少服装统一规则：${key}`);
      }
    }
  }
  if (f.priceYuan != null) ensure(Number.isFinite(f.priceYuan) && f.priceYuan > 0, '无效售价');
  if (f.stockPerSku != null) ensure(Number.isInteger(f.stockPerSku) && f.stockPerSku >= 0, '无效库存');
  if (f.presaleDays != null) ensure(Number.isInteger(f.presaleDays) && f.presaleDays >= 3 && f.presaleDays <= 20,
    '无效预售天数');
  if (f.sizeAdvice != null) ensure(['卡码拍大', '卡码拍小'].includes(f.sizeAdvice), '无效尺码建议');
  if (f.colors != null) ensure(Array.isArray(f.colors) && f.colors.length > 0
    && f.colors.every(value => typeof value === 'string' && value.trim())
      && new Set(f.colors).size === f.colors.length, '无效颜色数组');
  if (f.materialComponents != null) ensure(Array.isArray(f.materialComponents)
    && f.materialComponents.length > 0
    && f.materialComponents.every(value => typeof value === 'string' && value.trim())
    && new Set(f.materialComponents).size === f.materialComponents.length,
  '无效材质成分数组');
  ensure(!plan.actions || !plan.actions.some(x => /submit|publish|审核|发布/i.test(x)),
    '方案不得包含发布或提交审核动作');
}

module.exports = { SITE, PENDING, SHOP_PRICE_YUAN, stockForHandcardPrice, CLOTHING_RULES, normalizeClothingFacts, createPlan,
  resolveImages, validateApprovedPlan, validateCopy, displayUnits };
