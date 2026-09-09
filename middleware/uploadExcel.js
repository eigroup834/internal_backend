const multer = require('multer');

const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype) || /\.(xlsx|xls)$/i.test(file.originalname || '')) {
      return cb(null, true);
    }
    cb(new Error('Only .xlsx or .xls files are allowed'));
  },
}).single('file');

// Wrapped so a bad/oversized file comes back as the same JSON error shape the
// rest of this API uses, instead of falling through to Express's HTML error page.
module.exports = function uploadExcel(req, res, next) {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large (max 20 MB)'
        : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
};
