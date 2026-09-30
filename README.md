# 快手小店新增商品

Windows 版商品草稿脚本与手卡生成器。商品方案、图片、登录资料和运行记录由使用者保存在本机，不包含在仓库中。

## 准备

安装 Node.js 20 或更新版本，运行 `npm install`。手卡生成需要 Codex 的演示文稿运行环境、Python 和 `reportlab`、`Pillow`；如运行环境不在默认位置，可设置 `RUNTIME_NODE_MODULES`、`CODEX_PRESENTATIONS_SKILL_DIR` 和 `PYTHON`。PDF 默认使用 Windows 字体目录中的微软雅黑、黑体或宋体，也可用 `HANDCARD_FONT_PATH` 指向本机的中文 TrueType 字体。

设置 `BROWSER_PATH` 可指定 Chrome 或 Edge 的程序路径。运行 `node src/cli.cjs browser` 会打开独立浏览器配置；请在该窗口自行登录快手小店。用 `node src/cli.cjs doctor` 检查连接。不要把账号密码、Cookie、API 密钥或浏览器配置加入仓库。

## 使用

```text
node src/cli.cjs prepare 商品.json --offline --output plans/商品.plan.json
node src/cli.cjs apply plans/商品.plan.json --dry-run
node src/cli.cjs apply plans/商品.plan.json
node src/cli.cjs handcard run-logs/handcard-data/某次保存.json
```

`prepare` 默认使用 `OPENAI_API_KEY` 调用图片模型；`--offline` 要求商品 JSON 已提供完整文案。执行 `apply` 前须审核方案并将 `review.approved` 设为 `true`。脚本只保存草稿，不提交审核或发布。

## 当前规则

- 新增商品弹窗固定选“发布全新商品”，不沿用旧草稿信息。
- 只有“女装 > 内搭”类目改为“女装 > T恤”；其他类目保持原分类。
- 单成分的“成分含量”选“95%以上”。多成分把所有材质分别选入“面料材质”，按最低占比选择“成分含量”区间；含羊毛时按羊毛占比。准确比例保留在手卡数据中。
- 未提供弹力时填“无弹”；备注不处理。
- 商品链接中各 SKU 售价固定为 9999 元。用户给出的价格只用于手卡；未给价格时手卡留空。库存为 1000 加手卡价格的整数部分，例如 69.9 元对应 1069；未给价格时为 1000。
- 手卡末栏为“商家”，使用用户提供的商家名。每天重新制作一份可编辑 PPT 和打印 PDF，A4 竖版每页两件商品，同日同款只保留最新一份。每张卡印有日期；新一天生成成功后清理旧手卡成品。

生成的手卡成品保存在本机的 `output/handcards` 和 `output/pdf`，不会上传到仓库。生成手卡所需的商品快照与图片也只保存在本机。
