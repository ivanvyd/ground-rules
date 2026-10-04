// Captured from `ffmpeg -progress progress.txt -stats_period 2` encoding 40 seconds of testsrc2
// at 1920x1080 with libx264 on Windows (ffmpeg 9.0). Nothing in it is private.

const BLOCK = (frame: number, size: number, outUs: number, state: 'continue' | 'end') =>
  [
    `frame=${frame}`,
    'fps=43.37',
    'stream_0_0_q=24.0',
    'bitrate=9622.4kbits/s',
    `total_size=${size}`,
    `out_time_us=${outUs}`,
    `out_time_ms=${outUs}`,
    'dup_frames=0',
    'drop_frames=0',
    'speed=1.41x',
    `progress=${state}`,
    '',
  ].join('\n')

/** Three blocks, then the start of a fourth that ffmpeg has not finished writing. */
export const PROGRESS_RUNNING =
  BLOCK(87, 3407920, 2833333, 'continue') +
  BLOCK(202, 8126512, 6666667, 'continue') +
  BLOCK(343, 13893680, 11366667, 'continue') +
  'frame=400\nfps=57.0\nout_time_us=13'

/** The last block ffmpeg writes. */
export const PROGRESS_FINISHED = BLOCK(343, 13893680, 11366667, 'continue') + BLOCK(1200, 48717063, 39933333, 'end')

/** The same, as Windows writes it. */
export const PROGRESS_FINISHED_CRLF = PROGRESS_FINISHED.replace(/\n/g, '\r\n')
