"""Draw the JM icon. Needs Pillow, fonttools, and Windows Segoe UI Bold."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = Path(__file__).parent
SIZE = 1024
BG = "#1e3a8a"
FONT = "C:/Windows/Fonts/segoeuib.ttf"
TEXT = "JM"
FONT_SIZE = int(SIZE * 0.51)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

image = Image.new("RGBA", (SIZE, SIZE))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle(
    (0, 0, SIZE - 1, SIZE - 1), radius=SIZE // 5, fill=BG
)
font = ImageFont.truetype(FONT, FONT_SIZE)
box = draw.textbbox((0, 0), TEXT, font=font)
width, height = box[2] - box[0], box[3] - box[1]
x = (SIZE - width) / 2 - box[0]
y = (SIZE - height) / 2 - box[1]
draw.text((x, y), TEXT, font=font, fill="white")

image.resize((512, 512), Image.Resampling.LANCZOS).save(HERE / "icon.png")
image.save(HERE / "icon.ico", sizes=[(size, size) for size in ICO_SIZES])

# Outline the same lettering so the sidebar SVG needs no installed font.
tt = TTFont(FONT)
glyphs = tt.getGlyphSet()
cmap = tt.getBestCmap()
scale = FONT_SIZE / tt["head"].unitsPerEm
baseline = y + font.getmetrics()[0]
paths = []
for index, char in enumerate(TEXT):
    offset = font.getlength(TEXT[:index + 1]) - font.getlength(char)
    pen = SVGPathPen(glyphs)
    glyphs[cmap[ord(char)]].draw(
        TransformPen(pen, (scale, 0, 0, -scale, x + offset, baseline))
    )
    paths.append(f'    <path d="{pen.getCommands()}"/>')
tt.close()
(HERE / "icon.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
    f'  <rect width="1024" height="1024" rx="{SIZE // 5}" fill="{BG}"/>\n'
    '  <g fill="#ffffff">\n'
    + "\n".join(paths)
    + '\n  </g>\n</svg>\n',
    encoding="utf-8",
)
