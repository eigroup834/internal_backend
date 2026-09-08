module.exports = function requestTiming({ slowMs = 500 } = {}) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms >= slowMs || res.statusCode >= 500) {
        const tag = res.statusCode >= 500 ? 'ERROR' : 'SLOW';
        console.warn(`[${tag}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`);
      }
    });
    next();
  };
};
