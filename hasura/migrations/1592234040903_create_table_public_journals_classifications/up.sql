
CREATE TABLE "public"."journals_classifications"("id" serial NOT NULL, "journal_id" integer NOT NULL, "classification_id" integer NOT NULL, PRIMARY KEY ("id") , FOREIGN KEY ("classification_id") REFERENCES "public"."classifications"("id") ON UPDATE no action ON DELETE no action, FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON UPDATE no action ON DELETE no action, UNIQUE ("id"));