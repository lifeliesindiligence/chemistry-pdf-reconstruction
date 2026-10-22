# 化学试卷智能重构（开发中）

本仓库是独立 MIT 开源工具源码，不包含用户的试卷、题库、扫描图片、识别结果、日志或账号凭据。完整 PDF→DOCX 产品尚未完成。

## 实测状态

- 第一阶段：用户本人完成 OpenAI 官方 Sign in with ChatGPT 授权；订阅权限通过校验，一次私有真实扫描 PNG 的图像请求返回 `response.completed` 和识别文字。一次成功不代表批量限额、自动续期或稳定性已验证。
- 第二阶段（进行中）：`stage2.mjs` 和 `stage2_document.py` 实现本地浏览器选择单份 PDF/页码、渲染选中页、官方授权后的云端逐页抄录，以及文字生成可编辑 DOCX 的试验链路。离线测试、真实扫描 PDF 只读渲染，以及此前真实识别所得首题文字生成 DOCX 已通过。新链路尚未再次授权和运行真实 PDF→DOCX 端到端测试，不得称第二阶段完成。
- 当前仅支持单页实验，不支持整份或批量处理、断点续跑、图示局部保留/绘制、公式 OMML、原图对照纠错、页眉水印处理及最终排版。模型自报“完整”不代表人工核对无误；图示可能缺失，生成的 DOCX 不得直接当忠实复刻成品。

## 本地运行与数据边界

本地需 Node.js 和带 PyMuPDF 的 Python。文档模块使用标准库 OOXML，不需安装 `python-docx`。

```text
node --test phase1.test.mjs stage2.test.mjs
python stage2_document_test.py
node stage2.mjs --private-dir <仓库外私有目录> --python <带PyMuPDF的python.exe>
```

浏览器只访问程序打印的 `127.0.0.1` 地址。官方登录、授权必须由用户本人完成。程序不读取其他应用的令牌；授权令牌仅在进程内存里，重启后需重新授权。原始 PDF 只读，页面图片、识别数据和 DOCX 写入仓库外私有目录。选定的扫描页会发送至 OpenAI，切勿选用无权处理的文件；不得上传个人试卷到本仓库。

`stage2_document.py render --pdf <PDF> --pages 1 --output-dir <私有目录>` 仅渲染，不执行 OCR。`stage2_document.py build --input <识别页JSON> --output <DOCX>` 仅将已有文字排为可编辑段落和原生表格，不执行 OCR，也不插入整页图片。

目前不是日常批量转换工具。不要将离线测试、模型自报完整或首题样例视为整卷质量验收。
