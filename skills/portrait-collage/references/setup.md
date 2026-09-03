# 运行环境安装

默认 `integrated` 模式不运行本地人脸脚本。仅在使用 `source-face-harmonized` 或 `source-face-exact` 时准备以下环境。

## 要求

- Node.js 22 或更高版本
- Python 3.12
- 仓库已包含固定的人脸定位模型及 SHA-256 清单

## Windows PowerShell

```powershell
Set-Location "$env:USERPROFILE\.codex\skills\portrait-collage"
npm ci
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm test
```

## macOS 或 Linux

```bash
cd ~/.codex/skills/portrait-collage
npm ci
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
npm test
```

`npm ci` 使用 `package-lock.json`；Python 使用 `requirements.txt` 中的固定版本。不要提交 `.venv` 或 `node_modules`。运行检测时，将命令示例中的 `<python>` 替换为该技能 `.venv` 内的 Python，将 `<node>` 替换为 Node.js 可执行文件。
