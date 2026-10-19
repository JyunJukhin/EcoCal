# 生成 EcoCal PWA 图标（Apple 蓝底 + 白色上升折线，象征持仓增长）
# 运行：python tools/make-icons.py
import os
from PIL import Image, ImageDraw

def make(size, path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 蓝底大圆角
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill='#0071e3')
    s = size / 512.0
    # 白色上升折线（买入成本 → 当前市值）
    pts = [(128, 340), (232, 288), (330, 306), (396, 204)]
    p = [(x * s, y * s) for x, y in pts]
    lw = max(3, int(30 * s))
    d.line(p, fill='white', width=lw, joint='curve')
    # 末点高亮圆点（当前市值）
    cx, cy = p[-1]
    rr = max(3, int(21 * s))
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill='white')
    img.save(path, 'PNG')
    print('已生成', path, size, 'x', size)

make(512, 'icons/icon-512.png')
make(192, 'icons/icon-192.png')
