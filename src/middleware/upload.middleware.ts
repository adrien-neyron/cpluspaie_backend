import multer from 'multer';
import { MAX_FILE_BYTES } from '../services/files.service.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});
