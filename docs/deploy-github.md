# EcoCal 部署到 GitHub Pages 分步指南

> 前提：已忽略 github.io 在国内的访问问题（需自备稳定网络环境）。
> 纯网页操作，**不需要安装 Git**；会 Git 的话文末附命令行方式。

## 第 1 步：注册/登录 GitHub

1. 打开 <https://github.com>，注册账号（或直接登录）。
2. 登录后点右上角 **+** → **New repository**（新建仓库）。

## 第 2 步：新建仓库

1. Repository name 填：`ecocal`（小写即可，这决定访问网址）。
2. **注意选 Public（公开）**——免费版 GitHub Pages 只支持公开仓库。本项目代码不含任何密钥或数据，公开无风险。
3. 其他保持默认，点 **Create repository**。

## 第 3 步：上传文件

1. 进入新仓库页面，点 **Add file → Upload files**。
2. 把下面这些内容**整体拖进**上传区（拖入时 GitHub 会自动保留 `css/ js/ icons/` 的文件夹结构）：

```
index.html
manifest.json
sw.js
css/style.css          （保持 css/style.css 路径）
js/app.js              （保持 js/app.js 路径）
icons/icon-192.png
icons/icon-512.png
```

3. **不要上传**：`ecocal-backup-*.json`（数据会被公开下载）、`docs/`、`tests/`、`tools/`（不是必须）。
4. 页面底部 Commit changes → 点 **Commit changes**。

## 第 4 步：开启 GitHub Pages

1. 仓库页面点 **Settings（设置）**。
2. 左侧菜单选 **Pages**。
3. "Build and deployment" 区域：
   - Source 选 **Deploy from a branch**
   - Branch 选你仓库的实际分支名（新建仓库常见 **main**；用 `git init` 本地新建的常见 **master**，本项目的本地分支就是 master），目录选 **/(root)** → **Save**
4. 等 1–3 分钟，刷新页面，顶部会出现你的网址：

```
https://你的用户名.github.io/ecocal/
```

5. 点击打开，看到页面就成功了。以后每次改动文件（重新上传覆盖），几分钟内自动生效。

## 第 5 步：手机添加主屏幕（变成本地 App）

用手机浏览器打开上面的网址（**首次必须联网**，用于安装离线缓存）：

- **Android（Chrome）**：打开后底部/菜单会出现"添加到主屏幕 / 安装应用"提示，点击确认即可。
- **iPhone（Safari）**：点底部「分享」按钮 → 「添加到主屏幕」→ 添加。

之后主屏幕上的 EcoCal 图标：

- 全屏启动（无地址栏），**断网也能打开**（数据在手机浏览器本地）；
- 数据与电脑端互不相通，迁移用「导出/复制备份 → 手机导入/粘贴」。

## 更新版本的方法

1. 本地改好文件后，回到 GitHub 仓库用同样的 **Upload files** 覆盖同名文件。
2. **若改了 js/css**：顺手把 [sw.js](../sw.js) 里的 `CACHE_NAME` 版本号改一下（如 `ecocal-shell-v1` → `ecocal-shell-v2`），否则手机端可能继续用旧缓存。
3. 手机打开一次网址（联网），首次可能仍显示旧版，**再打开一次**即更新为新版。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 打开是 404 | 仓库名拼错，或 Pages 还没部署好，等 1–3 分钟刷新；确认 URL 是 `用户名.github.io/仓库名/` |
| 图标显示空白/灰色 | 手机浏览器刚打开还没装好缓存，多刷新一次；确保 icons 目录已上传 |
| 手机"添加到主屏幕"是灰色 | 页面需通过 https 正常加载过一次，检查网络能否访问你的网址 |
| 想换 Cloudflare Pages | 上传同样这些文件即可，代码无需任何改动，迁移成本极低 |

## 附：Git 命令行方式（可选）

```bash
git init
git add index.html manifest.json sw.js css js icons
git commit -m "EcoCal v3"
git branch -M master    # 与新仓库默认分支一致即可（main / master 都行）
git remote add origin https://github.com/你的用户名/ecocal.git
git push -u origin master
# 然后按第 4 步在 Settings → Pages 里开启即可，之后每次 push 自动更新
```
