-- Tambala Pay schema for Supabase PostgreSQL.
-- Run this in Supabase SQL Editor before deploying the backend.
-- The Express backend connects with DATABASE_URL; never expose that credential in browser code.

create table if not exists public.payment_requests (
  id uuid primary key,
  tx_ref text not null unique,
  description text not null,
  customer_name text,
  customer_email text,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'MWK',
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  checkout_url text,
  provider_reference text,
  receipt_number text unique,
  verification_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.invoices (
  id uuid primary key,
  invoice_number text not null unique,
  description text not null,
  customer_name text,
  customer_email text,
  total_amount numeric(12,2) not null check (total_amount > 0),
  currency char(3) not null default 'MWK',
  status text not null default 'open' check (status in ('open','partially_paid','paid','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  due_at timestamptz
);

create table if not exists public.invoice_payments (
  id uuid primary key,
  invoice_id uuid not null references public.invoices(id),
  tx_ref text not null unique,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'MWK',
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  checkout_url text,
  provider_reference text,
  receipt_number text unique,
  verification_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists payment_requests_created_at_idx on public.payment_requests (created_at desc);
create index if not exists payment_requests_status_idx on public.payment_requests (status);
create index if not exists invoices_created_at_idx on public.invoices (created_at desc);
create index if not exists invoice_payments_invoice_id_idx on public.invoice_payments (invoice_id, created_at desc);
create index if not exists invoice_payments_status_idx on public.invoice_payments (status);

-- Defense in depth: these tables are accessed by the trusted server using DATABASE_URL,
-- not directly from a browser using Supabase publishable/anon keys.
alter table public.payment_requests enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_payments enable row level security;

revoke all on table public.payment_requests from anon, authenticated;
revoke all on table public.invoices from anon, authenticated;
revoke all on table public.invoice_payments from anon, authenticated;
