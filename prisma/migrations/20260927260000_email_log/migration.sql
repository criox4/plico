-- Invite email caps. splittr schema only.
CREATE TABLE "splittr"."email_log" (
  "id" TEXT NOT NULL,
  "byId" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_log_byId_at_idx" ON "splittr"."email_log"("byId", "at");
CREATE INDEX "email_log_to_at_idx" ON "splittr"."email_log"("to", "at");
