-- DropForeignKey
ALTER TABLE "splittr"."expense_share" DROP CONSTRAINT "expense_share_memberId_fkey";

-- AddForeignKey
ALTER TABLE "splittr"."expense_share" ADD CONSTRAINT "expense_share_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "splittr"."member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

