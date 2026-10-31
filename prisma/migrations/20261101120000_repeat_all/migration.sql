-- Recurring expenses that split with everyone in the group each month, including people who join later. splittr schema only.
ALTER TABLE "splittr"."expense" ADD COLUMN "repeatAll" BOOLEAN NOT NULL DEFAULT false;
