-- Settlements recorded by someone other than the payee wait for the payee to confirm.
ALTER TABLE "splittr"."expense" ADD COLUMN "pending" BOOLEAN NOT NULL DEFAULT false;
