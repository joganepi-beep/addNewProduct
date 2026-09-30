function compositionRange(components) {
  if (!Array.isArray(components) || !components.length) throw new Error('缺少面料成分');
  if (components.length === 1) return '95%以上';
  const chosen = components.find(item => /羊毛/.test(item.name))
    || components.reduce((lowest, item) => item.percent < lowest.percent ? item : lowest);
  const percent = chosen.percent;
  if (percent < 10) return '10%以下';
  if (percent < 20) return '10%（含）-20%';
  if (percent < 30) return '20%（含）-30%';
  if (percent < 50) return '30%（含）-50%';
  if (percent < 70) return '50%(含)-70%';
  if (percent < 95) return '70%（含）-95%';
  return '95%以上';
}

function exactComposition(components) {
  return components.map(item => `${item.name}${item.percent}%`).join('、');
}

module.exports = { compositionRange, exactComposition };
