const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const MAX_BYTES = 2 * 1024 * 1024;

async function prepareMainImages(files) {
  const outputDir = path.resolve('run-logs', 'prepared-images');
  const prepared = [];
  for (const file of files) {
    const source = await fs.readFile(file);
    const meta = await sharp(source).metadata();
    const rotated = [5, 6, 7, 8].includes(meta.orientation);
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    if (!width || !height) throw new Error(`无法读取主图尺寸：${file}`);
    if (width === height) { prepared.push(file); continue; }

    const side = Math.min(2000, Math.max(width, height));
    const hash = crypto.createHash('sha256').update(source).update('square-white-v1').digest('hex').slice(0, 16);
    const output = path.join(outputDir, `main-${hash}.jpg`);
    await fs.mkdir(outputDir, { recursive: true });
    let valid = false;
    try {
      const stat = await fs.stat(output);
      const existing = await sharp(output).metadata();
      valid = stat.size <= MAX_BYTES && existing.width === side && existing.height === side;
    } catch { /* no cached output */ }
    if (!valid) {
      for (const quality of [90, 82, 74]) {
        await sharp(source).rotate().resize(side, side, {
          fit: 'contain', background: '#ffffff'
        }).flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toFile(output);
        if ((await fs.stat(output)).size <= MAX_BYTES) { valid = true; break; }
        await fs.unlink(output);
      }
      if (!valid) throw new Error(`补白后的方图仍超过 2MB：${file}`);
    }
    prepared.push(output);
    console.log(`[上架草稿] 主图 ${width}×${height} 已等比补白为 ${side}×${side}：${output}`);
  }
  return prepared;
}

module.exports = { prepareMainImages };
