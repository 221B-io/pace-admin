
CREATE TABLE "public"."funders_namevariances"("id" serial NOT NULL, "name" text NOT NULL, "funder_id" integer NOT NULL, PRIMARY KEY ("id") , FOREIGN KEY ("funder_id") REFERENCES "public"."funders"("id") ON UPDATE no action ON DELETE restrict, UNIQUE ("id"));