/**
 * Process env defaults — must be imported FIRST, before anything that touches
 * the libuv threadpool (sharp, async fs, crypto). libuv reads
 * UV_THREADPOOL_SIZE lazily when the pool is first used, so setting it here
 * (ahead of the first async job) takes effect; setting it later would not.
 *
 * sharp runs each image job on the threadpool. We run several jobs
 * concurrently (see IMAGE_WORK_LIMIT in index.js), so the pool needs at least
 * that many threads or jobs would serialize on the default pool of 4.
 */
import os from 'os';

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.max(4, os.cpus().length));
}
