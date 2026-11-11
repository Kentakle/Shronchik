import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

// Browsers can play GIF delays below 2 centiseconds as 100 ms. Keep the
// source timestamps and skip frames too close together for GIF playback.
const selectFrames = "select='isnan(prev_selected_t)+gte(round(t*100)-round(prev_selected_t*100),2)'";

export async function videoToGif(file: File, signal: AbortSignal) {
  signal.throwIfAborted();
  const ffmpeg = new FFmpeg();
  const cancel = () => ffmpeg.terminate();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await ffmpeg.load({ coreURL, wasmURL });
    await ffmpeg.createDir('/source');
    // WORKERFS reads slices of the browser File as FFmpeg needs them.
    const mounted = await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: 'video', data: file }] }, '/source');
    if (!mounted) throw new Error('FFmpeg could not open the video file');
    const demuxer = file.name.toLowerCase().endsWith('.webm') ? 'matroska' : 'mov';
    const input = ['-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', demuxer, '-i', '/source/video'];

    // Generate the palette in a separate pass so the filter graph doesn't buffer the whole video.
    const palette = await ffmpeg.exec([...input, '-map', '0:V:0', '-vf', `${selectFrames},palettegen=stats_mode=diff`, '-frames:v', '1', 'palette.png']);
    if (palette !== 0) throw new Error('FFmpeg could not generate a GIF palette');

    const encoded = await ffmpeg.exec([...input, '-i', 'palette.png',
      '-filter_complex', `[0:V:0]${selectFrames}[video];[video][1:v]paletteuse=diff_mode=rectangle[gif]`,
      '-map', '[gif]', '-fps_mode', 'passthrough', '-enc_time_base', '1/100', '-loop', '0', 'output.gif']);
    if (encoded !== 0) throw new Error('FFmpeg could not encode the GIF');

    const gif = await ffmpeg.readFile('output.gif');
    if (typeof gif === 'string' || !gif.byteLength || !(gif.buffer instanceof ArrayBuffer)) throw new Error('FFmpeg returned no GIF data');
    return new File([new Uint8Array(gif.buffer, gif.byteOffset, gif.byteLength)], file.name.replace(/\.[^.]+$/, '') + '.gif', { type: 'image/gif' });
  } finally {
    signal.removeEventListener('abort', cancel);
    ffmpeg.terminate();
  }
}
