# MP4 转 M3U8 浏览器工具

使用 `@ffmpeg/ffmpeg` 在浏览器本地完成 MP4 → M3U8 (HLS) 转换，无需上传视频到服务器。

## 功能特性

- 拖放或点击选择 MP4 文件。
- 自动注册 Service Worker，启用跨源隔离以支持 `SharedArrayBuffer`。
- 使用 FFmpeg 生成 HLS 播放列表及 TS 分片。
- 自动打包输出为 ZIP，方便一次性下载。

## 本地运行

1. 安装任意静态服务器（示例使用 `serve`）：
   ```bash
   npm install -g serve
   ```
2. 启动服务器（需 HTTPS 或 localhost），并确保 `vendor/` 目录一并被托管：
   ```bash
   serve .
   ```
3. 首次打开页面时浏览器会注册 Service Worker，页面会自动刷新一次，随后即可点击“开始转换”。

> **提示**：若浏览器或部署环境无法使用 Service Worker（例如 `file://` 方式直接打开），则无法启用 `SharedArrayBuffer`，FFmpeg 也就无法运行。

## 本地依赖

项目已经将以下脚本放在 `vendor/` 目录，避免 COOP/COEP 限制导致的跨域加载失败：

- `vendor/ffmpeg/`：`@ffmpeg/ffmpeg@0.12.6` 的 UMD 版本。
- `vendor/ffmpeg-core/`：`@ffmpeg/core@0.12.6`（包含 `ffmpeg-core.js/.wasm`）。
- `vendor/fflate/`：`fflate@0.8.2` UMD 版。

部署时务必连同 `vendor/` 上传，否则浏览器会因 `COEP: require-corp` 拦截远程 CDN 资源。

## 已知限制

- 浏览器需要支持 WebAssembly 并允许注册 Service Worker。
- 大文件转换会占用较多内存及 CPU，建议在桌面浏览器中使用。
- 输出的 ZIP 包含 HLS 播放列表与全部 TS 分片，解压后保持目录结构即可播放。