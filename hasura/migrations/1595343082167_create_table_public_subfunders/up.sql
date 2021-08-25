
CREATE TABLE "public"."subfunders"("id" serial NOT NULL, "funder_id" integer NOT NULL, "name" text NOT NULL, "short_name" text NOT NULL, "uri" text NOT NULL, PRIMARY KEY ("id") , FOREIGN KEY ("funder_id") REFERENCES "public"."funders"("id") ON UPDATE no action ON DELETE restrict, UNIQUE ("id"));