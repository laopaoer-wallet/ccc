# MP4 转 HLS (m3u8) 示例

该示例展示如何使用 `ffmpeg.wasm` 在 Node.js 中将本地 MP4 文件切片为 HLS（`.m3u8` + `.ts`）资源，可在网页或播放器中进行自适应点播。

## 准备

```bash
npm install
```

## 转码

```bash
npm run convert -- <输入MP4路径> [输出目录=dist] [分片秒数=4]
```

示例：

```bash
npm run convert -- ./videos/demo.mp4 ./dist/hls 6
```

完成后，`dist/hls` 下会出现 `master.m3u8` 与对应的 `segment_000.ts` 等文件，可直接放到静态服务器供前端播放。