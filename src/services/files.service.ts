/**
 * Contrôle des fichiers déposés : extension + type MIME + signature binaire
 * (on ne fait pas confiance au Content-Type envoyé par le navigateur).
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // limite des fonctions serverless Vercel (~4,5 Mo)

const ALLOWED: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  pdf: { mime: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  // DOCX / XLSX sont des archives ZIP (signature PK\x03\x04)
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    magic: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  },
};

export function validateUpload(fileName: string, data: Buffer): { mime: string; safeName: string } {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const rule = ALLOWED[ext];
  if (!rule) throw httpError(400, 'Format non autorisé (PDF, DOCX ou XLSX uniquement).');
  if (data.length === 0) throw httpError(400, 'Fichier vide.');
  if (data.length > MAX_FILE_BYTES) throw httpError(413, 'Fichier trop volumineux (4 Mo maximum).');
  if (!rule.magic(data)) throw httpError(400, "Le contenu du fichier ne correspond pas à son extension.");
  const safeName = fileName.replace(/[^\w.\- ()éèêàùçÉÈÀ]/g, '_').slice(0, 200);
  return { mime: rule.mime, safeName };
}

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
