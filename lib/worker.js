// Background jobs: send queued WhatsApp messages every minute and
// look for customers to win back every 10 minutes.
const { processQueue } = require('./messages');
const { runRetentionAll } = require('./retention');

let started = false;
function start() {
  if (started) return;
  started = true;
  let tick = 0;
  const run = async () => {
    try {
      if (tick % 10 === 0) runRetentionAll();
      tick++;
      await processQueue();
    } catch (e) {
      console.error('worker error:', e.message);
    }
  };
  setTimeout(run, 3000);
  setInterval(run, 60000).unref?.();
}
module.exports = { start };
