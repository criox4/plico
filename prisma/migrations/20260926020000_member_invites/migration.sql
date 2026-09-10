-- DropForeignKey
ALTER TABLE "splittr"."group" DROP CONSTRAINT "group_createdById_fkey";

-- AlterTable
ALTER TABLE "splittr"."group" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "splittr"."member" ADD COLUMN     "email" TEXT,
ADD COLUMN     "inviteToken" TEXT,
ADD COLUMN     "invitedAt" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "member_inviteToken_key" ON "splittr"."member"("inviteToken");

-- CreateIndex
CREATE INDEX "member_email_idx" ON "splittr"."member"("email");

-- AddForeignKey
ALTER TABLE "splittr"."group" ADD CONSTRAINT "group_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "splittr"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

