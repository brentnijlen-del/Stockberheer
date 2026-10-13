# Herstel: `UPDATE requires a WHERE clause`

Dit is een gerichte aanvulling op PR #1, branch `codex/volledig-herstel`. De gebruiker meldt dat de v2-website inmiddels gepubliceerd is en de v2-migratie is geïnstalleerd. Admin-login werkt, maar categorie-aanmaak faalt. Tijdens dit herstel zijn op productie uitsluitend functiedefinities/configuratie gelezen; geen opdrachten of migraties uitgevoerd.

## Oorzaak en onderzoek

Alle tien applicatiefuncties in `public` en `material_private` zijn via alleen-lezen metadata onderzocht en met de repository vergeleken. Alleen `material_private.execute(jsonb,uuid)` bevatte zelfstandige UPDATE/DELETE-opdrachten zonder WHERE:

| Opdracht | Gevolg | Herstel |
| --- | --- | --- |
| Revisie-update aan het eind van iedere opdracht | Zelfs categorie-aanmaak wordt teruggedraaid | `WHERE singleton=true`; ontbrekende revisierij geeft een fout en rollback |
| Categorieën archiveren tijdens back-upherstel | Herstel stopt en rolt terug | `WHERE id = ANY(restore_category_ids)` |
| Producten archiveren tijdens back-upherstel | Herstel stopt en rolt terug | `WHERE id = ANY(restore_product_ids)` |
| Locaties archiveren tijdens back-upherstel | Herstel stopt en rolt terug | `WHERE id = ANY(restore_location_ids)` |
| Materiaallijsten vervangen tijdens back-upherstel | `DELETE requires a WHERE clause` | `WHERE location_id = ANY(restore_location_ids)` |
| Bestaande lothoeveelheden resetten tijdens back-upherstel | Herstel stopt en rolt terug | `WHERE id = ANY(restore_lot_ids)` |

De herstel-ID-lijsten worden na validatie onder de bestaande transactionele opdracht-lock vastgelegd. Ze begrenzen de wijzigingen tot de bestaande toepassingsrecords; lege lijsten raken geen rijen. Loten en historische mutaties worden niet verwijderd. De oorspronkelijke herstelbetekenis blijft behouden: een expliciete admin-herstelopdracht vervangt de actuele inventaris en behoudt historie.

Andere zelfstandige UPDATE/DELETE-opdrachten hadden al een WHERE. `INSERT ... ON CONFLICT ... DO UPDATE` is een insert/upsert op een expliciete unieke sleutel; dit is geen onbegrensde zelfstandige UPDATE. De echte safeupdate-module accepteert die opdrachten in de tests. `ON DELETE RESTRICT` en `SELECT ... FOR UPDATE` zijn geen DELETE-/UPDATE-mutaties.

De eerdere lokale PostgreSQL-tests hadden de extra Supabase-WHERE-controle niet geladen. Daardoor werd deze fout bij de eerste oplevering gemist. De testverbindingen laden die module nu verplicht.

## Exacte aanvullende migratie

Voor de **reeds geïnstalleerde database** is uitsluitend dit bestand bedoeld:

`supabase/migrations/20261013122409_safeupdate_where_fix.sql`

Dit bestand bevat een transactionele `CREATE OR REPLACE FUNCTION material_private.execute(command jsonb, request_id uuid)` met de volledige gecorrigeerde functie. Het vereist een reeds bestaande v2-functie en heeft een lokale lock-timeout van vijf seconden. Bestaand eigenaarschap en EXECUTE-rechten blijven behouden. Het bestand kan opnieuw worden uitgevoerd.

De migratie zelf voert geen voorraadopdracht uit, herstelt geen back-up en verandert geen records. Alle DML staat in het functie-body en wordt alleen bij een latere toegestane applicatieopdracht uitgevoerd. Er zijn geen accountwijzigingen, grants/revokes, RLS-wijzigingen, oude-tabelingrepen of safeupdate-overrides.

De oorspronkelijke `20261013102455_material_management_v2.sql` is eveneens gecorrigeerd, uitsluitend voor nieuwe installaties. **Voer die oorspronkelijke installer niet opnieuw uit op het bestaande project.** Voer ook `production_cutover.sql`, testbootstrap en testfixtures niet uit op productie.

Na afzonderlijke expliciete toestemming kan de projectbeheerder de volledige aanvullende migratie in één SQL Editor-uitvoering toepassen. Daarna kan de admin opnieuw een categorie aanmaken. Er is voor deze SQL-fix geen frontend-deploy nodig. Een mislukte categorie-aanmaak is lokaal aantoonbaar teruggedraaid; er zijn geen halve categorie-/audit-/revisiewrites om op te ruimen.

## Regressies en resultaten

De tests gebruiken de **echte pg-safeupdate-module**, broncommit `37dbc9c4acf5e2504adf2b218e9c6b41751022f3` van `eradman/pg-safeupdate`. Bron en PostgreSQL-17-headers zijn vastgezet en met SHA256 gecontroleerd. `session_preload_libraries=safeupdate` wordt op iedere lokale testverbinding ingesteld; `safeupdate.enabled` blijft `on`. Dit is uitsluitend testconfiguratie, geen productiewijziging.

- Oude functie uit commit `99e3c71`: categorie-aanmaak reproduceert exact `UPDATE requires a WHERE clause` / SQLSTATE `21000` op de revisie-update. Categorie, voorraad, audit en revisie zijn daarna ongewijzigd.
- Upgrade van een gevulde lokale database: de migratie zelf behoudt alle gegevens en functie-eigenschappen; categorie-aanmaak slaagt daarna en verhoogt de revisie precies eenmaal.
- Herhaling met hetzelfde request-ID veroorzaakt geen dubbele mutatie. Opnieuw installeren van de herstelmigratie verandert geen gegevens.
- Ieder van de vijf onbegrensde herstelstatements is afzonderlijk gereproduceerd door uitsluitend zijn predicate weg te laten. Iedere fout rolt alle voorafgaande herstelwijzigingen terug. Met alle predicates slaagt herstel, met behoud van lot-ID’s, lotgegevens, hoeveelheden, uitleningen en historie.
- Onbegrensde UPDATE en DELETE op een testtabel blijven geblokkeerd; specifieke WHERE-opdrachten werken.
- Ontbrekende revisierij weigert de opdracht in plaats van een ongetrackte wijziging te bevestigen.
- Statische regressies controleren alle zelfstandige mutaties in beide migraties en bewijzen dat fresh-install- en upgradefuncties gelijk zijn; geen `WHERE true` of algemene beveiligingsuitschakeling.

`npm test`: **47 tests geslaagd**, geen mislukkingen of overgeslagen tests. `npm run test:browser`: **12 tests geslaagd**, inclusief admin-categorie-aanmaak via de RPC met safeupdate geladen. `npm run build`: geslaagd.

Geen productie-write, fysieke apparaat-/printertest of live-back-upherstel uitgevoerd. De bestaande browserflows zijn tegen fictieve gegevens getest. Gebruikersaccounts, productievoorraad en oude tabellen blijven ongemoeid.
