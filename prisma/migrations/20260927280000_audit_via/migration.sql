-- Which history entries came from a confirmed Ask Plico card. splittr schema only.
ALTER TABLE "splittr"."audit_event" ADD COLUMN "via" TEXT;
