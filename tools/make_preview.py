"""生成 README 用的示意图：模糊的代码编辑器背景 + 前景广告风格直播窗。"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, random

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs')
W, H = 1760, 1120
S = 2
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"

def f(size):
    return ImageFont.truetype(FONT, size)

def hgrad(size, left, right):
    w, h = size
    img = Image.new('RGB', (w, 1))
    for x in range(w):
        t = x / max(1, w - 1)
        img.putpixel((x, 0), tuple(int(left[i] + (right[i] - left[i]) * t) for i in range(3)))
    return img.resize((w, h))

def vgrad(size, top, bottom):
    w, h = size
    img = Image.new('RGB', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        img.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((w, h))

def shadow(img, box, r, blur, alpha):
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box, radius=r, fill=(0, 0, 0, alpha))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))

def code_background(size):
    """假装是一屏代码的编辑器"""
    w, h = size
    bg = Image.new('RGBA', (w, h), (30, 32, 38, 255))
    d = ImageDraw.Draw(bg)
    # 侧边栏
    d.rectangle([0, 0, 210 * S, h], fill=(36, 39, 46, 255))
    for i in range(18):
        y = 90 * S + i * 30 * S
        d.rounded_rectangle([24 * S, y, (24 + random.randint(70, 150)) * S, y + 9 * S], 4 * S, fill=(96, 102, 116, 255))
    # 标签页
    d.rectangle([210 * S, 0, w, 46 * S], fill=(27, 29, 35, 255))
    d.rounded_rectangle([224 * S, 10 * S, 420 * S, 38 * S], 6 * S, fill=(38, 41, 49, 255))
    d.rounded_rectangle([250 * S, 20 * S, 380 * S, 28 * S], 4 * S, fill=(150, 156, 170, 190))
    # 代码行
    colors = [(198, 120, 221), (97, 175, 239), (152, 195, 121), (229, 192, 123), (86, 182, 194), (120, 126, 140)]
    y = 92 * S
    for i in range(26):
        x = 250 * S + random.choice([0, 0, 0, 30 * S])
        n = random.randint(2, 5)
        for k in range(n):
            wl = random.randint(40, 190) * S
            d.rounded_rectangle([x, y, x + wl, y + 10 * S], 4 * S,
                                fill=colors[random.randrange(len(colors))] + (210,))
            x += wl + random.randint(14, 26) * S
            if x > w - 200 * S:
                break
        y += 27 * S
        if y > h - 40 * S:
            break
    return bg.filter(ImageFilter.GaussianBlur(3.2 * S))

def make(with_side_ads=False, name='screenshot.png'):
    img = Image.new('RGBA', (W * S, H * S))
    img.alpha_composite(code_background((W * S, H * S)))
    # 压暗背景
    veil = Image.new('RGBA', img.size, (8, 9, 13, 130))
    img.alpha_composite(veil)

    d = ImageDraw.Draw(img)
    wx0, wy0 = 250 * S, 170 * S
    ww, wh = 1260 * S, 780 * S
    wx1, wy1 = wx0 + ww, wy0 + wh
    shadow(img, [wx0 + 8 * S, wy0 + 30 * S, wx1 + 8 * S, wy1 + 30 * S], 20 * S, 26 * S, 165)
    d.rounded_rectangle([wx0, wy0, wx1, wy1], radius=18 * S, fill=(14, 15, 19, 255),
                        outline=(255, 106, 61, 255), width=3 * S)

    bar_h = 44 * S
    bar = hgrad((ww - 4 * S, bar_h), (255, 95, 61), (255, 176, 61))
    mask = Image.new('L', (ww - 4 * S, bar_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, ww - 4 * S, bar_h + 20 * S], radius=16 * S, fill=255)
    img.paste(bar, (wx0 + 2 * S, wy0 + 2 * S), mask)

    d = ImageDraw.Draw(img)
    cy = wy0 + 2 * S + bar_h // 2
    x = wx0 + 16 * S
    d.rounded_rectangle([x, cy - 12 * S, x + 44 * S, cy + 12 * S], radius=5 * S,
                        fill=(240, 122, 78), outline=(255, 214, 190), width=S)
    d.text((x + 22 * S, cy), "推广", font=f(14 * S), fill=(255, 255, 255, 255), anchor="mm")
    x += 56 * S
    d.text((x, cy), "限时特惠 · 新用户专享 0 元购", font=f(19 * S), fill=(255, 255, 255, 255), anchor="lm")

    def chip(rx, label, on=False):
        fnt = f(14 * S)
        w = d.textlength(label, font=fnt) + 18 * S
        d.rounded_rectangle([rx - w, cy - 12 * S, rx, cy + 12 * S], radius=6 * S,
                            fill=(255, 236, 226) if on else (223, 104, 60),
                            outline=(255, 255, 255) if on else (255, 198, 172), width=S)
        if on:
            d.text((rx - w / 2, cy), label, font=fnt, fill=(200, 74, 40), anchor="mm")
            return w
        d.text((rx - w / 2, cy), label, font=fnt, fill=(255, 255, 255, 255), anchor="mm")
        return w

    rx = wx1 - 18 * S
    d.rounded_rectangle([rx - 20 * S, cy - 10 * S, rx, cy + 10 * S], radius=5 * S, fill=(255, 250, 246))
    d.text((rx - 10 * S, cy - S), "×", font=f(16 * S), fill=(217, 72, 43, 255), anchor="mm")
    rx -= 28 * S
    for label in ["声音", "黑听", "侧栏"]:
        rx -= chip(rx, label) + 5 * S
    rx -= chip(rx, "置顶") + 5 * S
    rx -= chip(rx, "透明 +") + 5 * S
    d.text((rx - 20 * S, cy), "60%", font=f(12 * S), fill=(255, 255, 255, 240), anchor="mm")
    rx -= 42 * S
    chip(rx, "透明 -")

    vx0, vy0, vx1, vy1 = wx0 + 2 * S, wy0 + 2 * S + bar_h, wx1 - 2 * S, wy1 - 2 * S - 44 * S
    foot_h = 44 * S

    if with_side_ads:
        vh = vy1 - vy0
        vw = int(vh * 9 / 16)
        cx = (vx0 + vx1) // 2
        content = [cx - vw // 2, vy0, cx + vw // 2, vy1]
        d.rectangle(content, fill=(24, 20, 32, 255))
        # 竖屏画面里放一个柔和的人像占位（抽象光斑）
        blob = Image.new('RGBA', img.size, (0, 0, 0, 0))
        bd = ImageDraw.Draw(blob)
        bd.ellipse([content[0] + 40 * S, vy0 + 90 * S, content[2] - 40 * S, vy0 + 420 * S], fill=(228, 170, 120, 90))
        bd.ellipse([content[0] + 90 * S, vy0 + 160 * S, content[2] - 90 * S, vy0 + 380 * S], fill=(245, 205, 170, 110))
        img.alpha_composite(blob.filter(ImageFilter.GaussianBlur(26 * S)))
        d = ImageDraw.Draw(img)
        d.text(((content[0] + content[2]) // 2, vy1 - 60 * S), "竖屏直播画面", font=f(15 * S), fill=(255, 255, 255, 70), anchor="mm")

        for side in (0, 1):
            ax0 = vx0 if side == 0 else content[2]
            ax1 = content[0] if side == 0 else vx1
            img.paste(vgrad((ax1 - ax0, vy1 - vy0), (255, 79, 45), (255, 194, 77)), (ax0, vy0))
            d = ImageDraw.Draw(img)
            mid = (vy0 + vy1) // 2
            adx = (ax0 + ax1) // 2
            d.text((adx, vy0 + 34 * S), "广告", font=f(11 * S), fill=(255, 255, 255, 190), anchor="mm")
            words = ["限 时", "秒 杀"] if side == 0 else ["新 人", "专 享"]
            d.text((adx, mid - 86 * S), words[0], font=f(24 * S), fill=(255, 255, 255, 255), anchor="mm")
            d.text((adx, mid - 46 * S), words[1], font=f(24 * S), fill=(255, 255, 255, 255), anchor="mm")
            d.text((adx, mid + 22 * S), "¥0", font=f(32 * S), fill=(255, 255, 255, 255), anchor="mm")
            d.rounded_rectangle([adx - 33 * S, mid + 62 * S, adx + 33 * S, mid + 100 * S], radius=11 * S,
                                fill=(255, 255, 255, 245))
            d.text((adx, mid + 81 * S), "立即抢", font=f(13 * S), fill=(217, 72, 43, 255), anchor="mm")
    else:
        vid = vgrad((vx1 - vx0, vy1 - vy0), (46, 34, 58), (12, 14, 21))
        img.paste(vid, (vx0, vy0))
        blob = Image.new('RGBA', img.size, (0, 0, 0, 0))
        bd = ImageDraw.Draw(blob)
        bd.ellipse([vx0 + 180 * S, vy0 - 80 * S, vx0 + 760 * S, vy0 + 420 * S], fill=(255, 170, 120, 46))
        bd.ellipse([vx1 - 520 * S, vy1 - 420 * S, vx1 - 80 * S, vy1], fill=(120, 140, 255, 40))
        img.alpha_composite(blob.filter(ImageFilter.GaussianBlur(60 * S)))
        d = ImageDraw.Draw(img)
        for gx in range(vx0, vx1, 54 * S):
            d.line([gx, vy0, gx, vy1], fill=(255, 255, 255, 9))
        for gy in range(vy0, vy1, 54 * S):
            d.line([vx0, gy, vx1, gy], fill=(255, 255, 255, 9))
        d.text(((vx0 + vx1) // 2, (vy0 + vy1) // 2 - 10 * S), "直 播 画 面", font=f(26 * S), fill=(255, 255, 255, 60), anchor="mm")

    # 直播中
    d.rounded_rectangle([vx0 + 14 * S, vy0 + 14 * S, vx0 + 92 * S, vy0 + 42 * S], radius=5 * S, fill=(220, 60, 70, 240))
    d.ellipse([vx0 + 24 * S, vy0 + 24 * S, vx0 + 32 * S, vy0 + 32 * S], fill=(255, 255, 255, 255))
    d.text((vx0 + 40 * S, vy0 + 28 * S), "直播中", font=f(12 * S), fill=(255, 255, 255, 255), anchor="lm")

    # 促销条
    ph = 50 * S
    promo = hgrad((vx1 - vx0, ph), (255, 95, 61), (255, 176, 61))
    img.paste(promo, (vx0, vy1 - ph))
    d = ImageDraw.Draw(img)
    py = vy1 - ph // 2
    d.text((vx0 + 18 * S, py), "限时秒杀", font=f(21 * S), fill=(255, 255, 255, 255), anchor="lm")
    d.text((vx0 + 136 * S, py), "距结束  02:30:05", font=f(13 * S), fill=(255, 255, 255, 235), anchor="lm")
    d.rounded_rectangle([vx1 - 132 * S, py - 17 * S, vx1 - 16 * S, py + 17 * S], radius=17 * S, fill=(255, 255, 255, 250))
    d.text((vx1 - 74 * S, py), "立即抢购", font=f(15 * S), fill=(217, 72, 43, 255), anchor="mm")
    d.text((vx1 - 18 * S, vy1 - ph - 14 * S), "广告", font=f(10 * S), fill=(255, 255, 255, 135), anchor="rm")

    # 底部输入
    d.rectangle([vx0, vy1, vx1, wy1 - 2 * S], fill=(26, 29, 36, 255))
    d.rounded_rectangle([vx0 + 10 * S, vy1 + 8 * S, vx1 - 10 * S, vy1 + 36 * S], radius=8 * S,
                        fill=(15, 17, 22, 255), outline=(255, 255, 255, 24), width=S)
    d.text((vx0 + 24 * S, vy1 + 22 * S), "说点什么…", font=f(14 * S), fill=(107, 114, 128, 255), anchor="lm")

    out = os.path.join(OUT, name)
    final = img.resize((W, H), Image.LANCZOS).convert('RGB')
    final.save(out, quality=92)
    print('saved', out)

random.seed(7)
make(False, 'screenshot.png')
make(True, 'screenshot-sideads.png')
