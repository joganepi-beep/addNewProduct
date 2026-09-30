const test = require('node:test');
const assert = require('node:assert/strict');
const { compositionRange } = require('../src/composition.cjs');
const { normalizeClothingFacts, stockForHandcardPrice } = require('../src/plan.cjs');

test('多成分按最低比例，含羊毛时按羊毛比例', () => {
  assert.equal(compositionRange([{ name: '粘胶纤维', percent: 50 },
    { name: '莫代尔纤维', percent: 50 }]), '50%(含)-70%');
  assert.equal(compositionRange([{ name: '羊毛', percent: 30 },
    { name: '粘胶纤维', percent: 50 }, { name: '氨纶', percent: 20 }]), '30%（含）-50%');
  assert.equal(compositionRange([{ name: '聚酯纤维', percent: 100 }]), '95%以上');
});

test('商品价固定 9999，库存提示码使用手卡价格整数部分', () => {
  const facts = normalizeClothingFacts(['女装', 'T恤'], { handcardPriceYuan: 69.9,
    materialComposition: [{ name: '聚酯纤维', percent: 100 }] });
  assert.equal(facts.priceYuan, 9999);
  assert.equal(facts.stockPerSku, 1069);
  assert.deepEqual(facts.attributes['面料材质'], ['聚酯纤维']);
  assert.equal(facts.attributes['成分含量'], '95%以上');
  assert.equal(stockForHandcardPrice(null), 1000);
});
