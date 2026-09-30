const fs = require('node:fs');
const path = require('node:path');

function createAudit(planFile, outputDir = path.resolve('run-logs')) {
  fs.mkdirSync(outputDir, { recursive: true });
  const base = path.basename(planFile, path.extname(planFile)).replace(/[^a-zA-Z0-9_-]/g, '-');
  const file = path.join(outputDir, `apply-${base}-${Date.now()}.jsonl`);
  function record(type, data = {}) {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`, 'utf8');
  }
  return { file, record };
}

module.exports = { createAudit };
