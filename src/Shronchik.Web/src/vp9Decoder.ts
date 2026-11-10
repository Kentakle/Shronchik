import { CustomVideoDecoder, VideoSample } from 'mediabunny';
import type { EncodedPacket, VideoCodec } from 'mediabunny';

const unspecifiedLevel = /^(vp09\.\d{2})\.00\./;

// Some MP4 recorders write level 00. WebCodecs needs a defined level in its configuration.
export class Vp9UnspecifiedLevelDecoder extends CustomVideoDecoder {
  static supports(codec: VideoCodec, config: VideoDecoderConfig) {
    return typeof VideoDecoder !== 'undefined' && codec === 'vp9' && unspecifiedLevel.test(config.codec);
  }

  private readonly decoder = new VideoDecoder({
    output: frame => this.onSample(new VideoSample(frame)),
    error: error => this.onError(error),
  });

  init() {
    this.decoder.configure({ ...this.config, codec: this.config.codec.replace(unspecifiedLevel, '$1.62.') });
  }

  decode(packet: EncodedPacket) {
    this.decoder.decode(packet.toEncodedVideoChunk());
    if (this.decoder.decodeQueueSize >= 8)
      return new Promise<void>(resolve => this.decoder.addEventListener('dequeue', () => resolve(), { once: true }));
  }

  flush() { return this.decoder.flush(); }

  close() {
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
