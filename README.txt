Hulpdienst Materiaalbeheer — Rode Kruis-Vlaanderen, Afdeling Nijlen

Versie 2 gebruikt persoonlijke Supabase-accounts, een aparte relationele database,
servervalidatie, transacties en een onveranderbare mutatiehistoriek.

Deze branch is een voorstel. Er wordt niet automatisch naar productie gepubliceerd.
Lees docs/INGEBRUIKNAME.md voordat je SQL uitvoert of een site publiceert.
De oude live database blijft onveilig zolang de goedgekeurde cutover niet is uitgevoerd.

Ontwikkeling:
  npm ci
  npm run build
  npm run serve

index.html is het bronbestand. Publiceer later uitsluitend de gebouwde dist/-map;
deze bevat lokaal gebundelde scanner-, QR- en barcodebibliotheken en veilige headers.
SUPABASE_URL en SUPABASE_PUBLISHABLE_KEY kunnen bij de build worden ingesteld.
Gebruik voor acceptatietests een afzonderlijk Supabase-testproject.
Gebruik nooit een geheime of service_role-sleutel in de browser/build.

Automatische tests (vereisen een uitsluitend hiervoor gemaakte lokale database):
  docker run -d --name nijlen-test-db -e POSTGRES_PASSWORD=fictitious-local-only \
    -e POSTGRES_DB=material_test -p 127.0.0.1:55432:5432 postgres:17
  npm test
  npm run test:browser

Tests weigeren een database buiten localhost of met een andere naam dan material_test.
Ze bouwen fictieve Auth-tabellen en voorraad op in die lokale testdatabase.
Ze mogen NOOIT worden uitgevoerd tegen een echte Supabase-database.
Voor browsers is Chromium nodig; stel CHROMIUM_PATH in op het lokale uitvoerbare bestand.

Voorraadback-ups bevatten catalogus, koffermateriaallijsten en loten.
Historiek, uitleningen en tekortmeldingen kunnen afzonderlijk worden geëxporteerd.
Herstel bewaart bestaande historiek en vereist dat openstaande uitleningen terug zijn.
Een voorraadback-up vervangt geen volledige databaseback-up van Supabase.
Oude JSON-back-up converteren zonder upload:
  node scripts/convert-legacy-backup.mjs oude.json voorraad-v2.json
Controleer oude open uitleningen handmatig: vrije omschrijvingen kunnen niet veilig
naar specifieke producten en loten worden vertaald. Oude historiek blijft apart bewaard.

Meer informatie:
  docs/AUDIT-HERSTEL.md — alle auditpunten en concrete oplossingen
  docs/TESTRESULTATEN.md — testresultaten en beperkingen
  docs/INGEBRUIKNAME.md — veilige ingebruikname, goedkeuringen en gevolgen voor andere apps
