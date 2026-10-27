export type DeadlineKind = 'variables' | 'validation' | 'payment' | 'social' | 'other';
export type DeadlineStatus = 'todo' | 'in_progress' | 'done';
export type CompanyStatus = 'prospect' | 'active' | 'archived';

export interface Company {
  id: string;
  name: string;
  siret: string | null;
  ccn: string | null;
  headcount: number | null;
  status: CompanyStatus;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Deadline {
  id: string;
  company_id: string;
  company_name?: string;
  kind: DeadlineKind;
  title: string;
  due_date: string; // YYYY-MM-DD
  status: DeadlineStatus;
  notes: string | null;
}

export interface DocumentMeta {
  id: string;
  company_id: string | null;
  title: string;
  description: string | null;
  category: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  published: boolean;
  created_at: string;
}
