// Test-only: answers every /v1/messages call the way a subscription usage limit does (HTTP 429).
const http = require('http');

const resetAt = Math.floor(Date.now() / 1000) + 3600;
http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '3600',
      'x-should-retry': 'false',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(resetAt),
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit reached (test)' } }));
  });
}).listen(18998, '127.0.0.1');
