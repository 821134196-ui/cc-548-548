"""本地生成虚构证件遮罩图(SVG)。所有证件均为虚构样例, 号码已遮罩。"""
import os

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="340" height="214" viewBox="0 0 340 214">
  <rect width="340" height="214" rx="12" fill="#f4f7fc" stroke="#123b7a" stroke-width="2"/>
  <rect width="340" height="40" rx="12" fill="#123b7a"/>
  <text x="18" y="26" font-family="sans-serif" font-size="15" fill="#ffffff" font-weight="bold">虚构身份证件 · SAMPLE</text>
  <rect x="18" y="58" width="86" height="108" rx="6" fill="#dbe5f4" stroke="#9db4d8"/>
  <circle cx="61" cy="96" r="22" fill="#9db4d8"/>
  <ellipse cx="61" cy="150" rx="32" ry="20" fill="#9db4d8"/>
  <text x="122" y="82" font-family="sans-serif" font-size="13" fill="#33475f">姓名　{name_masked}</text>
  <text x="122" y="108" font-family="sans-serif" font-size="13" fill="#33475f">性别　{gender}　年龄 {age}</text>
  <text x="122" y="134" font-family="sans-serif" font-size="13" fill="#33475f">号码　{number_masked}</text>
  <text x="122" y="160" font-family="sans-serif" font-size="13" fill="#33475f">类型　{doc_type}</text>
  <text x="170" y="120" font-family="sans-serif" font-size="34" fill="#f96d00"
        fill-opacity="0.28" font-weight="bold" transform="rotate(-18 170 120)">虚构证件</text>
  <text x="18" y="200" font-family="sans-serif" font-size="10" fill="#7a8aa0">本卡为系统演示用虚构样例, 不对应任何真实证件</text>
</svg>
"""


def generate_mask_image(path, name_masked, gender, age, number_masked, doc_type):
    svg = TEMPLATE.format(name_masked=name_masked, gender=gender, age=age,
                          number_masked=number_masked, doc_type=doc_type)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    return path
