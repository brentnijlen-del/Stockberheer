# Testresultaten — 13 oktober 2026

## Aanvulling — vrijwilligersportaal en automatische mail (14 oktober 2026)

Op branch `codex/duidelijk-portaal-meldingen`: 82 automatische tests en 25 Chromium-browsertests geslaagd op PostgreSQL 17 met echte pg-safeupdate. Vrijwilligers mogen voortaan alleen verbruik, tekorten en hulpvragen registreren; tellingen en uitleningen blijven getest als beheerdershandelingen. Nieuwe tests controleren hulpvraagprivacy, contactinstellingen, SQL-rechten, dubbele mailincidenten, twee gelijktijdige workers, leases, beheerderblokkering, vervaldatum vandaag, de provider-retrygrens en gesimuleerde verzend-/netwerkfouten. Zie [installatie en beperkingen](VRIJWILLIGERSPORTAAL_EN_MAIL.md). Dit is nog niet op productie geïnstalleerd; Resend is nog niet aangesloten.

De eerdere teksten hieronder beschrijven historische controles vóór de inmiddels goedgekeurde v2-, gebruikersbeheer- en PIN-publicaties. De gebruiker heeft PIN-aanmelding en uitnodigingsmail nadien ook live bevestigd.

**Aanvulling safeupdate:** 47 unit-/SQL-/databasetests en 12 browsertests slagen nu met de echte pg-safeupdate-module actief. Zie [de gerichte herstelbeschrijving](SAFEUPDATE-HERSTEL.md). De resultaten hieronder beschrijven de oorspronkelijke oplevering.

## Uitgevoerd

| Controle | Resultaat |
| --- | --- |
| `npm test` | 40 tests geslaagd; 0 mislukt, 0 overgeslagen. |
| PostgreSQL-integratie | 16 tests binnen `npm test`, op een aparte lokale PostgreSQL 17-database. |
| Sessies/netwerk | 10 tests: identiteit, late antwoorden, abort, time-out, veilige retry, gatewayfouten en geen onterechte succesmelding. |
| Domein/back-ups | 8 tests: aantallen, escaping, codes, Belgische datum, tekorten, meldingen, relaties en conversie. |
| Scannerlifecycle | 6 tests: USB-routing, login/stale buffer, camerafallback, late start, navigatie en HTTPS. |
| `npm run test:browser` | 11 tests geslaagd; 0 mislukt. |
| Layoutmatrix | 11 beheerdersschermen × 6 breedtes (320, 375, 390, 768, 1024, 1440): geen horizontale pagina-overflow of JavaScript-fouten. Tabellen kunnen binnen hun eigen container scrollen. |
| `npm run build` | Geslaagd; lokale assets en beveiligingsheaders gegenereerd. |
| `npm audit --omit=dev` | 0 bekende kwetsbaarheden in productieafhankelijkheden tijdens deze controle. |
| Productiecontrole | Uitsluitend read-only metadata: geen nieuw schema, oude policies nog aanwezig, geen account- of voorraadwijzigingen. |

## Wat de tests aantonen

- Nieuwe migratie installeert transactioneel vanaf nul; alle applicatietabellen gebruiken RLS.
- Anonieme bezoekers en niet-leden kunnen geen RPC gebruiken. Directe clienttoegang tot privé-tabellen en audithelpers is geblokkeerd.
- Rollen worden uit de database afgeleid. Vrijwilligers kunnen geen catalogus, targets, ontvangst, admincorrecties, verwerking of back-upherstel uitvoeren.
- Ingetrokken lidmaatschap, ontbrekende Auth-sessie en verlopen `not_after` blokkeren toegang.
- Gehele aantallen, relaties, lotidentiteit, dubbele codes en vervaldatums worden servermatig beschermd.
- Verschillende loten blijven behouden; FEFO sluit vervallen loten uit. Correcties met verouderde versies of foutieve tweede lotregel rollen volledig terug.
- Gelijktijdige mutaties met aparte verbindingen blijven behouden; onvoldoende voorraad laat maar één van twee concurrerende verbruiksopdrachten toe. Twintig gelijktijdige aanvullingen produceren één lot met twintig stuks.
- Een verzoek met hetzelfde idempotency-ID wordt maar eenmaal toegepast; hergebruik van een ID met andere inhoud wordt geweigerd.
- Tekorten voeden de aanvullijst, meldingen worden opnieuw actief en irrelevante producten veroorzaken geen koffermelding.
- Uitleningen verminderen voorraad; gedeeltelijke en volledige retouren herstellen de oorspronkelijke loten, ook als materiaal ondertussen vervallen is.
- Back-upherstel weigert ongeldige indeling/relaties en een verouderde revisie. Historiek wordt behouden, nooit als aangeleverd auditlog geïmporteerd.
- Productcategorie wordt opgeslagen; productnaam/code met HTML-achtige inhoud voert geen JavaScript uit in de browser.
- Een verloren antwoord nadat de database al heeft gecommit kan veilig worden herhaald zonder dubbele uitlening.
- Twee browseraccounts kunnen tegelijk verbruiken. Automatische synchronisatie bewaart een ingevulde telling, waarna een verouderde telling correct wordt geweigerd.
- Tokenvernieuwing via de Supabase SDK blijft binnen dezelfde identiteit. De test simuleert de Auth HTTP-antwoorden.
- QR/Code128-labels worden zonder externe labelverzoeken gegenereerd. Printgegevens bevatten lotnummers en vervaldatums.
- De oude productietabellen kunnen met de goedgekeurde cutover worden afgesloten; zonder goedkeuringsinstelling weigert het SQL-script. Dit is uitsluitend lokaal getest.

## Bestaande tests

De vier oorspronkelijke authenticatietests gebruikten tekstfragmenten uit het oude inline script. Door de modularisering werken die fragmentharnassen niet meer. Hun beveiligingsdoelen zijn vervangen en uitgebreid in `tests/auth.test.mjs`, `tests/database.test.mjs` en de browsertests: geen voorraad vóór login, verplichte lidmaatschappen, serverrollen/tokengebruik en bescherming bij opslagfouten/accountwisseling. Validatiefouten melden de gebruiker tegenwoordig niet onnodig af; sessie-/lidmaatschapsfouten doen dat wel.

## Niet op echte apparaten of productie getest

- Echte Windows-, Android- en iPhone-browsers; er is Chromium op Linux gebruikt.
- Fysieke USB-scanners, AZERTY/QWERTY firmwareinstellingen en cameradetectie/optiek. Camera-lifecycle en fallback zijn met stubs getest; USB-events zijn in unit- en browsertests uitgevoerd.
- A4-printers en fysieke labelkwaliteit. Gegenereerde afdrukgegevens zijn wel gecontroleerd.
- Volledige Supabase Auth-/PostgREST-integratie tegen een apart Supabase-testproject. SQL is echt PostgreSQL; de test-Auth endpoints zijn een lokale adapter, geen volledige Supabase-stack.
- Productie-installatie, goedkeuring, deploy, browserheaders op de uiteindelijke nieuwe site en eventuele externe afnemers van oude tabellen.
- Langdurige belasting en zeer grote historische datasets. De globale transactie-lock past bij een afdelingsinventaris, maar moet bij aanzienlijk groter gebruik opnieuw worden gemeten.

Deze beperkingen zijn acceptatiestappen vóór productie, geen claim dat de huidige live website hersteld is.
