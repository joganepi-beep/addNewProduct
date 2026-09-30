"""Render a handcard PDF with vector text and the original product image."""

import json
import os
import sys
from pathlib import Path

from PIL import Image
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT = 'HandcardArialUnicode'


def font_path():
    configured = os.environ.get('HANDCARD_FONT_PATH')
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return str(candidate)
        raise RuntimeError(f'HANDCARD_FONT_PATH 指向的字体不存在：{candidate}')
    system_root = os.environ.get('WINDIR')
    if system_root:
        fonts = Path(system_root) / 'Fonts'
        for name in ('msyh.ttc', 'simhei.ttf', 'simsun.ttc'):
            candidate = fonts / name
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError('找不到中文字体；请将 HANDCARD_FONT_PATH 指向本机的中文 TrueType 字体')


def wrap_text(text, font_size, width):
    result = []
    for paragraph in str(text).split('\n'):
        line = ''
        for char in paragraph:
            next_line = line + char
            if line and pdfmetrics.stringWidth(next_line, FONT, font_size) > width:
                result.append(line)
                line = char
            else:
                line = next_line
        result.append(line)
    return result


def cell_text(pdf, text, x, y, width, height, font_size, color, bold=False):
    pad = 6
    lines = wrap_text(text, font_size, width - 2 * pad)
    while len(lines) * font_size * 1.35 > height - 2 * pad and font_size > 8:
        font_size -= 0.4
        lines = wrap_text(text, font_size, width - 2 * pad)
    pdf.setFillColor(HexColor(color))
    pdf.setFont(FONT, font_size)
    baseline = y + height - pad - font_size
    for line in lines:
        if baseline < y + 2:
            break
        pdf.drawString(x + pad, baseline, line)
        if bold:
            pdf.drawString(x + pad + 0.13, baseline, line)
        baseline -= font_size * 1.35


def render(payload, output_path):
    cards = payload['cards']
    layout = payload['layout']
    pdfmetrics.registerFont(TTFont(FONT, font_path(), subfontIndex=0))
    pdf_width, pdf_height = 210 * mm, 297 * mm
    sx = pdf_width / layout['width']
    sy = (pdf_height / 2) / layout['height']
    pdf = canvas.Canvas(output_path, pagesize=(pdf_width, pdf_height), pageCompression=1)
    pdf.setTitle('全部商品手卡（A4 每页两件）')
    for index, card in enumerate(cards):
        draw_card(pdf, card, layout, sx, sy, pdf_height, (index % 2) * layout['height'])
        if index % 2 == 1 or index == len(cards) - 1:
            pdf.showPage()
    pdf.save()


def draw_card(pdf, card, layout, sx, sy, pdf_height, top_offset):

    box_x, box_y, box_w, box_h = layout['image']
    source_w, source_h = Image.open(card['image']).size
    scale = min(box_w * sx / source_w, box_h * sy / source_h)
    image_w, image_h = source_w * scale, source_h * scale
    image_x = box_x * sx + (box_w * sx - image_w) / 2
    image_y = pdf_height - (top_offset + box_y + box_h) * sy + (box_h * sy - image_h) / 2
    pdf.drawImage(card['image'], image_x, image_y, image_w, image_h,
                  preserveAspectRatio=True, mask='auto')

    remarks = '\n'.join(f"{size} {card.get('sizeRemarks', {}).get(size, '')}".strip()
                        for size in card['sizes'])
    material = card.get('compositionExact')
    if not material:
        material = card.get('material') or '未提供'
        if card.get('composition'):
            material += f" {card['composition']}"
        elif card.get('material'):
            material += '（比例未提供）'
    rows = [
        [f"款号 + 名称  {card['title']}", '', '', '',
         f"品牌：{card.get('brand') or '未提供'}\n日期：{card['savedAt'][:10]}", ''],
        ['售价', f"￥{card['priceYuan']}" if card.get('priceYuan') not in (None, 9999) else '',
         '吊牌价', str(card.get('tagPriceYuan') or '未提供'), '佣金', '10%'],
        ['尺码', remarks, '', '', '颜色', '、'.join(card['colors'])],
        ['面料成分', material, '', '', card.get('garmentLengthLabel') or '衣长',
         card.get('garmentLength') or '未提供'],
        ['发货时效', f"预售 {card['presaleDays']} 天" if card.get('presaleDays') is not None else '未提供',
         '', '', '商家', card.get('merchant') or ''],
    ]
    merged = [
        [(0, 3), (4, 5)],
        [(i, i) for i in range(6)],
        [(0, 0), (1, 3), (4, 4), (5, 5)],
        [(0, 0), (1, 3), (4, 4), (5, 5)],
        [(0, 0), (1, 3), (4, 4), (5, 5)],
    ]
    table_x, table_y, _, _ = layout['table']
    columns, heights = layout['columns'], layout['rows']
    for row_idx, groups in enumerate(merged):
        top = top_offset + table_y + sum(heights[:row_idx])
        height = heights[row_idx] * sy
        bottom = pdf_height - top * sy - height
        for start, end in groups:
            left = (table_x + sum(columns[:start])) * sx
            width = sum(columns[start:end + 1]) * sx
            fill = '#0B3170' if row_idx == 0 else ('#F1F5F9' if row_idx % 2 == 0 else '#FFFFFF')
            pdf.setFillColor(HexColor(fill))
            pdf.setStrokeColor(HexColor('#CFD8E3'))
            pdf.setLineWidth(0.6)
            pdf.rect(left, bottom, width, height, fill=1, stroke=1)
            color = '#FFFFFF' if row_idx == 0 else ('#0B3170' if start in (0, 2, 4) else '#213347')
            size = (layout['titleSize'] if row_idx == 0 else layout['fontSize']) * sx
            cell_text(pdf, rows[row_idx][start], left, bottom, width, height,
                      size, color, bold=row_idx == 0 or start in (0, 2, 4))


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: handcard-pdf.py data.json output.pdf')
    payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    render(payload, sys.argv[2])


if __name__ == '__main__':
    main()
