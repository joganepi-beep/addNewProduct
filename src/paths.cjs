const fs = require('node:fs');
const path = require('node:path');

function resolveImagePath(file, referencePath) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('图片路径不能为空');
  if (fs.existsSync(file)) return path.resolve(file);
  const local = path.resolve(path.dirname(referencePath), file.replace(/\\/g, '/'));
  if (fs.existsSync(local)) return local;
  throw new Error(`图片不存在：${local}`);
}

function resolvePlanImages(plan, planPath) {
  const images = Object.fromEntries(Object.entries(plan.images || {}).map(([kind, files]) => [
    kind, Array.isArray(files) ? files.map(file => resolveImagePath(file, planPath)) : files
  ]));
  return { ...plan, images };
}

function portablePlanImages(plan, planPath) {
  const images = Object.fromEntries(Object.entries(plan.images || {}).map(([kind, files]) => [
    kind, Array.isArray(files) ? files.map(file => path.relative(path.dirname(planPath), file).split(path.sep).join('/')) : files
  ]));
  return { ...plan, images };
}

module.exports = { resolveImagePath, resolvePlanImages, portablePlanImages };
