import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import fs from 'node:fs/promises';
import path from 'node:path';

const [, , inputPath, outputDir = 'dist', segmentDuration = '4'] = process.argv;
const INPUT_VIRTUAL_FILE = 'input.mp4';
const OUTPUT_PLAYLIST = 'master.m3u8';

function ensureArgs() {
  if (!inputPath) {
    console.error('用法: npm run convert -- <输入MP4路径> [输出目录] [分片秒数]');
    process.exit(1);
  }
}

function extractSegmentNames(manifest) {
  const matches = manifest.match(/^.*\.ts$/gm);
  return matches ? [...new Set(matches.map((line) => line.trim()))] : [];
}

async function main() {
  ensureArgs();

  const ffmpeg = createFFmpeg({ log: true });
  await ffmpeg.load();

  const inputData = await fetchFile(inputPath);
  ffmpeg.FS('writeFile', INPUT_VIRTUAL_FILE, inputData);

  await ffmpeg.run(
    '-i',
    INPUT_VIRTUAL_FILE,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-hls_time',
    segmentDuration,
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    'segment_%03d.ts',
    OUTPUT_PLAYLIST
  );

  await fs.mkdir(outputDir, { recursive: true });

  const playlistData = ffmpeg.FS('readFile', OUTPUT_PLAYLIST);
  await fs.writeFile(path.join(outputDir, OUTPUT_PLAYLIST), playlistData);

  const manifestText = new TextDecoder().decode(playlistData);
  const segmentNames = extractSegmentNames(manifestText);

  for (const segment of segmentNames) {
    const segmentData = ffmpeg.FS('readFile', segment);
    await fs.writeFile(path.join(outputDir, segment), segmentData);
  }

  console.log(`已生成 ${segmentNames.length} 个 TS 分片和播放列表 ${path.join(outputDir, OUTPUT_PLAYLIST)}`);
}

main().catch((err) => {
  console.error('转换失败:', err);
  process.exit(1);
});
