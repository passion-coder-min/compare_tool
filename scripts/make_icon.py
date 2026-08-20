#!/usr/bin/env python3
"""生成应用图标源图：深色圆角背景 + 蓝绿双面板 + 白色双向箭头。"""
from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 深色圆角背景
d.rounded_rectangle([16, 16, SIZE - 16, SIZE - 16], radius=180, fill=(33, 37, 41, 255))

# 左右两个"文件"面板
pad, top, bottom = 120, 200, 824
panel_w = 340
d.rounded_rectangle([pad, top, pad + panel_w, bottom], radius=36, fill=(59, 130, 246, 255))    # 蓝
d.rounded_rectangle([SIZE - pad - panel_w, top, SIZE - pad, bottom], radius=36, fill=(34, 197, 94, 255))  # 绿

# 面板内的"文本行"
for panel_x in (pad, SIZE - pad - panel_w):
    for i, w in enumerate((180, 220, 150, 200)):
        y = top + 70 + i * 90
        d.rounded_rectangle([panel_x + 50, y, panel_x + 50 + w, y + 34], radius=17, fill=(255, 255, 255, 210))

# 中央白色双向箭头
cx = SIZE // 2
arrow_w, head = 46, 60
# 上箭头（指向左侧/蓝色）
d.rectangle([cx - arrow_w // 2, 340, cx + arrow_w // 2, 470], fill=(255, 255, 255, 255))
d.polygon([(cx - 130, 405), (cx + 10, 300), (cx + 10, 510)], fill=(255, 255, 255, 255))
# 下箭头（指向右侧/绿色）
d.rectangle([cx - arrow_w // 2, 554, cx + arrow_w // 2, 684], fill=(255, 255, 255, 255))
d.polygon([(cx + 130, 619), (cx - 10, 514), (cx - 10, 724)], fill=(255, 255, 255, 255))

img.save("app-icon.png")
print("saved app-icon.png")
