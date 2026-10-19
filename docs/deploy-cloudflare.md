# EcoCal 双托管 + 自定义域名指南

目标：GitHub 负责代码与版本管理，Cloudflare Pages 作为**国内可直连**的部署镜像。
做法：**一次 `git push`，两个平台同时自动更新**（Cloudflare 直连 GitHub 仓库）。

## 一、先接线 Cloudflare Pages（连 GitHub 仓库）

1. 注册/登录 <https://dash.cloudflare.com>（邮箱即可，无需手机验证）。
2. 左侧 **Workers & Pages → Create → Pages**（创建项目）。
3. 选 **Connect to Git** → 选择 GitHub → 授权 Cloudflare 访问你的 `EcoCal` 仓库。
4. 构建设置：
   - Framework preset：**None**（纯静态，无需构建）
   - Build command：留空
   - Build output directory：留空（部署仓库根目录）
5. 点 **Save and Deploy**，等 1 分钟左右，得到地址：
   ```
   https://<你的项目名>.pages.dev      （例如 https://ecocal.pages.dev）
   ```
6. 手机打开该地址，"添加到主屏幕"即完成手机端迁移。

之后每次 `git push` 到 GitHub，Cloudflare 会**自动拉取并重新部署**（无需手动上传）。

## 二、手机日常用哪个地址？

- **主力用 Cloudflare 地址**（国内可直连 → 能自动更新）；
- GitHub Pages 地址保留作备份/管理入口。
- ⚠️ **数据按域名（origin）隔离**：两个地址的 localStorage 数据互不相通。
  已在 github.io 域名下积累的数据，需要在 Cloudflare 地址下**导出 → 粘贴导入**迁移一次；
  之后**固定只用 Cloudflare 地址**，避免数据散在多个域名里。

## 三、自定义域名：能不能"国内顺畅"？

买域名本身不等于顺畅，关键看它解析到哪：

| 域名指向 | 是否需备案 | 国内体验 |
| --- | --- | --- |
| GitHub Pages（CNAME → `用户名.github.io`） | 否 | 可绕开对 github.io 的域名污染，但后端仍是 Fastly，**时好时坏，不算顺畅** |
| **Cloudflare Pages**（CNAME → `xxx.pages.dev`） | 否 | 国内基本可通、速度中等，**免费方案里体验最好**（推荐） |
| 国内云托管（腾讯云 COS / 阿里云 OSS） | **是（ICP 备案，约 1-4 周）** | 真正顺畅、稳定快 |

结论：**想"国内顺畅"又不走备案流程 → 把自定义域名绑到 Cloudflare Pages 是最优解**；
追求极致稳定且接受备案 → 再考虑腾讯云/阿里云国内节点。

### 把域名绑到 Cloudflare Pages

前提：域名能在任一家注册商（阿里云/腾讯云/Namesilo 等）解析（.com/.cn 等都可以）。推荐把域名的 **DNS 托管迁到 Cloudflare**（免费，后面解析记录全自动）。

1. Cloudflare 首页 → **Add a site** → 输入你的域名 → 选 Free 套餐。
2. Cloudflare 会给出两个 **NS 记录**，到你的注册商把域名的 NS 改成这两个（迁 DNS 托管），等生效（几分钟到几小时）。
3. 进入 Pages 项目 → **Custom domains** → 输入 `www.你的域名` 或直接 `你的域名` → 添加。Cloudflare 自动生成解析记录（CNAME 指向 `xxx.pages.dev`）。
4. 生效后，访问你的域名即可到达 EcoCal（https 自动配好）。
5. ⚠️ 换域名后手机数据同样按新域名隔离，需要在新域名下**导出 → 粘贴导入**一次；之后固定用主域名。

## 四、日常更新流程（固定后）

```bash
git add .
git commit -m "改动说明"
git push            # GitHub 自动更新 + Cloudflare 自动镜像更新
```

- GitHub Pages 生效：约 1–3 分钟。
- Cloudflare Pages 生效：约 30 秒–1 分钟。
- 手机看到新版：打开 App 一次（后台换缓存）→ 再打开一次即新版；iOS 必要时先关掉 App 再开。
- **改了 js/css 时**：记得改 [sw.js](../sw.js) 顶部的 `CACHE_NAME` 版本号（如 `ecocal-shell-v2`），否则手机可能继续用旧缓存。

## 五、答疑

| 问题 | 说明 |
| --- | --- |
| 不备案会被封吗？ | 境外服务器 + 不备案一般不会"被封"，但国内访问境外 CDN 有波动；备案只针对大陆节点接入 |
| 双托管会冲突吗？ | 不会，两个平台各自独立部署同一套代码；数据各自独立，记得只用主域名 |
| 以后删掉 GitHub Pages 只留 Cloudflare？ | 可以随时停用 GitHub Pages（Settings → Pages → 关），代码仓库仍可留在 GitHub 管理 |
