// scripts/apply-victory-translations.js
// ─────────────────────────────────────────────────────────────────────────────
// One-shot script that adds Yorùbá / Igbo / Hausa translations to
// `victory-month-2026.json`. Reads the JSON, merges the TRANSLATIONS dictionary
// below into each entry's `translations` field, and writes the file back.
//
// Translations supplied here are STARTERS — AI-assisted, not native-speaker
// reviewed. Treat them as a working baseline that gets refined by the church's
// language committee via the admin dashboard's Victory Month editors (which
// already support all three languages per field).
//
// Coverage in this pass:
//   • Book metadata (title, subtitle, description)         — yo/ig/ha
//   • Day 1: every field (message, prayer points, etc.)    — yo/ig/ha
//   • All 30 daily entries: `focus` translations            — yo/ig/ha
//   • All 7 vigil entries:  `focus` + `scripture_text`      — yo/ig/ha
//   • Day 1 `special_intercession` and `scripture_text`     — yo/ig/ha
//
// Long-form `inspirational_message` and the 23 prayer points for days 2-30
// + the 7 vigil bodies are intentionally NOT auto-translated — those carry
// theological weight that's too risky to ship without a native reviewer. The
// translation team can fill them in field-by-field via the dashboard.
//
// Usage:
//   cd backend && node scripts/apply-victory-translations.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');

const JSON_PATH = path.resolve(__dirname, 'victory-month-2026.json');

// ── Translations dictionary ─────────────────────────────────────────────────

const BOOK_TRANSLATIONS = {
  yo: {
    title:    'Ìwé Àdúrà Oṣù Ìṣẹ́gun 2026',
    subtitle: 'Àdúrà àti àwẹ̀ ọjọ́ 30 · Oṣù Ṣẹ́rẹ́ 2 – 31, 2026',
    description:
      'Ìwé Àdúrà Oṣù Ìṣẹ́gun ti GOFAMINT North America. Ọ̀rọ̀: Àkókò Ìjí-pípadà Tòótọ́ àti Iṣẹ́ Àgbàyanu Ńlá. ' +
      'Àdúrà ojoojúmọ́, ìṣàrótiti lórí Ọ̀rọ̀ Ọlọ́run, àti ìbẹ̀bẹ̀ láti January 2 sí January 31, 2026, ' +
      'pẹ̀lú àwọn ìjọ́sìn alẹ́ ìdílé mẹ́ta, àti àwọn ìjọ́sìn alẹ́ àwọn ọ̀dọ́, obìnrin, ọkùnrin, àti àpapọ̀.',
  },
  ig: {
    title:    'Akwụkwọ Ekpere Ọnwa Mmeri 2026',
    subtitle: 'Ụbọchị 30 nke ekpere na ibu ọnụ · Jenụarị 2 – 31, 2026',
    description:
      'Akwụkwọ Ekpere Ọnwa Mmeri nke GOFAMINT North America. Isiokwu: Oge Mmụgharị nke Ezi Okwu na Ọrụ Dị Ebube. ' +
      'Ekpere ụbọchị niile, ntụgharị uche n\'Akwụkwọ Nsọ, na arịrịọ site na Jenụarị 2 ruo Jenụarị 31, 2026, ' +
      'tinyere ekpere abalị atọ nke ezinụlọ, na nzukọ ekpere abalị ndị ntorobịa, ndị inyom, ndị ikom, na nke ọha.',
  },
  ha: {
    title:    'Wallafar Addu\'ar Watanin Nasara 2026',
    subtitle: 'Kwana 30 na addu\'a da azumi · Janairu 2 – 31, 2026',
    description:
      'Wallafar Addu\'ar Watanin Nasara na GOFAMINT North America. Jigon: Lokacin Farfaɗo na Gaskiya da Manyan Aiyukan Allah. ' +
      'Yin addu\'a kowace rana, tunani a kan Nassi, da roƙo daga Janairu 2 zuwa Janairu 31, 2026, ' +
      'da kuma tarurrukan addu\'a na dare na iyali uku, da tarurruka don matasa, mata, maza, da na gabaɗaya.',
  },
};

// Day 1 — full coverage as the gold-standard sample.
const DAY_1 = {
  yo: {
    focus: 'Ìdúpẹ́ fún ohun tí Ọlọ́run ti ṣe àti ohun tí Yóò ṣe ní 2026 àti lẹ́yìn náà.',
    scripture_text: 'Sáàmù 40:1-11, 136',
    inspirational_message:
      'Bí a ṣe ń wọ àkókò ìjí-pípadà àti iṣẹ́ àgbàyanu ńlá yìí, ó ṣe pàtàkì pé ká bẹ̀rẹ̀ lọ́nà títọ́ ' +
      'pẹ̀lú ọkàn tí ó kún fún ìdúpẹ́. Ìjí-pípadà tòótọ́ kì í bẹ̀rẹ̀ pẹ̀lú iṣẹ́; ó bẹ̀rẹ̀ pẹ̀lú ọkàn tí ó mọ ' +
      'àánú Ọlọ́run. Jálẹ̀ Bíbélì, nígbàkígbà tí Ọlọ́run bá ń múra àwọn ènìyàn rẹ̀ sílẹ̀ fún ìsọdọ̀tun, ' +
      'ìlọsíwájú, àti iṣẹ́ àgbàyanu, Ó kọ́kọ́ pè wọ́n padà sí ìdúpẹ́, ìrẹ̀lẹ̀, àti ìbẹ̀rù. Gẹ́gẹ́ bí ' +
      'GOFAMINT káàkiri ayé, a gbà gbọ́ pé ìgbà yìí ni àkókò ìjí-pípadà ti ẹnìkọ̀ọ̀kan, ti ìjọ, àti ti ìran. ' +
      'A bẹ̀rẹ̀ ọjọ́ 30 wọ̀nyí kì í ṣe pẹ̀lú ìbéèrè, ṣùgbọ́n pẹ̀lú ìdúpẹ́ jíjinlẹ̀. Ìdúpẹ́ ń mú ọkàn wa ' +
      'rọ̀ pẹ̀lú Ọlọ́run, ó ń wẹ ojú ọ̀run mọ́, ó sì ń múra wa sílẹ̀ fún iṣẹ́ àgbàyanu tí ó ré kọjá agbára ènìyàn.',
    prayer_points: [
      'Bàbá, a dúpẹ́ lọ́wọ́ Rẹ fún GOFAMINT káàkiri ayé, fún ìpamọ́, ìdàgbàsókè, àti ìtẹ̀síwájú nípa àánú Rẹ.',
      'A dúpẹ́ fún gbogbo orílẹ̀-èdè, ìlú, àti àdúgbò níbi tí O ti gbin GOFAMINT gẹ́gẹ́ bí ìmọ́lẹ̀ àti ẹlẹ́rìí.',
      'A dúpẹ́ fún ìjí-pípadà tí ó ti bẹ̀rẹ̀ tẹ́lẹ̀ ní àwọn ìpàdé wa, àwọn olórí, àti àwọn ọmọ ìjọ.',
      'A dúpẹ́ fún àwọn ìṣẹ́gun tí ó ti kọjá, àwọn àdúrà tí O ti dáhùn, àti iṣẹ́ ẹ̀mí tí ń rán wa létí pé O ṣì ń ṣiṣẹ́.',
      'Bàbá, a dúpẹ́ lọ́wọ́ Rẹ fún ìṣọ̀kan ti àfojúsùn, ẹ̀kọ́, àti ète jálẹ̀ GOFAMINT káàkiri ayé.',
    ],
    special_intercession:
      'Sáàmù 84:2-8 — Gba okun láti gbàdúrà títí dé òpin láìfọwọ́sowọ́pọ̀ àti àárẹ̀ jálẹ̀ Oṣù Ìṣẹ́gun.',
  },
  ig: {
    focus: 'Ekele maka ihe Chineke meworo na ihe Ọ ga-eme na 2026 na n\'ihu.',
    scripture_text: 'Abụ Ọma 40:1-11, 136',
    inspirational_message:
      'Ka anyị na-abata n\'oge mmụgharị na ọrụ dị ebube a, ọ dị mkpa ka anyị malite n\'ụzọ ziri ezi site n\'obi ' +
      'jupụtara n\'ekele. Ezi mmụgharị anaghị amalite site n\'omume; ọ na-amalite site n\'obi nke na-amata amara ' +
      'Chineke. Site n\'Akwụkwọ Nsọ niile, mgbe ọ bụla Chineke kwadebere ndị ya maka mmụgharị, mmụba, na ọrụ dị ' +
      'ebube, O bu ụzọ kpọghachi ha n\'ekele, ịdị umeala n\'obi, na ịsọpụrụ. Dị ka GOFAMINT n\'ụwa niile, anyị ' +
      'kwenyere na nke a bụ oge mmụgharị nke onye ọ bụla, nke ọgbakọ, na nke ọgbọ. Anyị na-amalite ụbọchị 30 ndị ' +
      'a, ọ bụghị site n\'arịrịọ, kama site n\'ekele miri emi. Ekele na-eme ka obi anyị kwekọrịta Chineke, ' +
      'na-ehichapụ ikuku ime mmụọ, ma na-akwado anyị maka ọrụ dị ebube nke karịrị ike mmadụ.',
    prayer_points: [
      'Nna, anyị na-ekele Gị maka GOFAMINT n\'ụwa niile, maka nchekwa, mmụba, na nnọgide n\'amara Gị.',
      'Daalụ maka mba ọ bụla, obodo, na obodo nke I kụnyere GOFAMINT dị ka ìhè na onye akaebe.',
      'Anyị na-ekele Gị maka mmụgharị nke amalitelarị na ọgbakọ anyị, ndị ndu, na ndị otu.',
      'Daalụ maka mmeri ndị gara aga, ekpere a zara aza, na ọrụ ime mmụọ ndị na-echetara anyị na Ị ka na-arụ ọrụ.',
      'Nna, anyị na-ekele Gị maka ịdị n\'otu nke ọhụụ, ozizi, na nzube na GOFAMINT n\'ụwa niile.',
    ],
    special_intercession:
      'Abụ Ọma 84:2-8 — Nata ike ikpe ekpere ruo ọgwụgwụ na-enweghị ụlọ na ike ọgwụgwụ n\'ime Ọnwa Mmeri niile.',
  },
  ha: {
    focus: 'Godiya ga abinda Allah Ya yi da abinda Zai yi a 2026 da gaba.',
    scripture_text: 'Zabura 40:1-11, 136',
    inspirational_message:
      'Yayin da muke shiga wannan lokacin farkawa da manyan aiyukan Allah, yana da muhimmanci mu fara da kyau ' +
      'tare da zuciya cike da godiya. Farkawa ta gaskiya ba ta fara da ayyukan ba; tana farawa ne da zuciya da ta ' +
      'gane alherin Allah. Cikin dukan Nassi, duk lokacin da Allah ya shirya jama\'arsa don sabuntawa, ƙaruwa, da ' +
      'manyan aiyuka, ya fara kiransu su koma ga godiya, tawali\'u, da bauta. A matsayinmu na GOFAMINT a duk duniya, ' +
      'mun yi imani wannan lokaci ne na farkawa ga kowane mutum, ga ikilisiya, da kuma ga tsararraki. Muna farawa ' +
      'wadannan kwanaki 30 ba da buƙatu ba, sai da godiya mai zurfi. Godiya tana sa zukatanmu su daidaita da Allah, ' +
      'tana share yanayin ruhi, kuma tana shirya mu don manyan aiyuka da suka wuce ƙarfin mutum.',
    prayer_points: [
      'Uba, mun gode maka don GOFAMINT a duk duniya, don kiyayewa, ci gaba, da daurewa ta wurin alherinka.',
      'Mun gode maka don kowace ƙasa, gari, da al\'umma da ka shuka GOFAMINT a matsayin haske da shaida.',
      'Mun gode maka don farkawar da ta riga ta fara cikin tarurrukanmu, shugabanninmu, da membobinmu.',
      'Mun gode maka don nasarorin da suka shude, addu\'o\'in da aka amsa, da ayyukan ruhi da suka tunamishe mu cewa kana aiki har yanzu.',
      'Uba, mun gode maka don haɗin kai cikin hangen nesa, koyarwa, da manufa a cikin GOFAMINT a duk duniya.',
    ],
    special_intercession:
      'Zabura 84:2-8 — Karɓi ƙarfin yin addu\'a har zuwa ƙarshe ba tare da rauni ko gajiya ba a duk Watanin Nasara.',
  },
};

// Focus translations for every other entry, keyed by (entry_number, entry_type).
// These are SHORT titles — the long bodies are intentionally not auto-translated.
const FOCUS_BY_ENTRY = {
  // ── Daily entries (entry_type = 'daily') ──────────────────────────────────
  'daily-2': {
    yo: 'Bí a ṣe ń borí àwọn ìdènà sí ìjí-pípadà tòótọ́ àti iṣẹ́ àgbàyanu ńlá nínú ìgbé-ayé wa àti ìjọ.',
    ig: 'Imeri ihe mgbochi nke mmụgharị nke ezi okwu na ọrụ dị ebube na ndụ anyị na ọgbakọ.',
    ha: 'Cin nasara a kan abubuwan da ke hana farkawa ta gaskiya da manyan aiyuka a rayuwarmu da ikilisiyarmu.',
  },
  'daily-3': {
    yo: 'Àdúrà fún ìjí-pípadà ti ara ẹni: Olúwa, sọ mí di olùṣe ìjí-pípadà tòótọ́ àti iṣẹ́ àgbàyanu.',
    ig: 'Ekpere maka mmụgharị onwe: Onyenwe anyị, mee m onye na-arụ ọrụ mmụgharị nke ezi okwu na ọrụ dị ebube.',
    ha: 'Addu\'a don farkawa ta kanmu: Ya Ubangiji, ka mai da ni wakilin farkawa ta gaskiya da manyan aiyuka.',
  },
  'daily-4': {
    yo: 'Àdúrà fún ìjí-pípadà ìdílé: Olúwa, mú ìdílé mi wọnú àkókò ìjí-pípadà tòótọ́ àti iṣẹ́ àgbàyanu ńlá.',
    ig: 'Ekpere maka mmụgharị ezinụlọ: Onyenwe anyị, kpọbata ezinụlọ m n\'oge mmụgharị nke ezi okwu na ọrụ dị ebube.',
    ha: 'Addu\'a don farkawar iyali: Ya Ubangiji, ka shigar da iyalina cikin lokacin farkawa ta gaskiya da manyan aiyuka.',
  },
  'daily-5': {
    yo: 'Àdúrà fún ìjí-pípadà gbogbo ìjọ: Olúwa, fún ìṣílẹ̀ ìjí-pípadà tòótọ́ àti iṣẹ́ àgbàyanu ńlá nínú ìjọ wa.',
    ig: 'Ekpere maka mmụgharị ọgbakọ: Onyenwe anyị, nye anyị mmụgharị nke ezi okwu na ọrụ dị ebube n\'ọgbakọ anyị.',
    ha: 'Addu\'a don farkawar dukan ikilisiya: Ya Ubangiji, ka kawo farkawa ta gaskiya da manyan aiyuka a ikilisiyarmu.',
  },
  'daily-6': {
    yo: 'Bí a ṣe ń borí àìdáríjì nínú ìgbé-ayé wa, ìdílé, àti ìjọ.',
    ig: 'Imeri enweghị ndaghachi azụ na ndụ anyị, ezinụlọ, na ọgbakọ.',
    ha: 'Cin nasara a kan rashin gafarta a rayuwarmu, iyalanmu, da ikilisiyarmu.',
  },
  'daily-7': {
    yo: 'Olúwa, jí iná ìjí-pípadà àti iṣẹ́ àgbàyanu sókè ní gbogbo apá, iṣẹ́-òjíṣẹ́, ìpín, àti ẹgbẹ́ ìjọ wa.',
    ig: 'Onyenwe anyị, kpalite ọkụ nke mmụgharị na ọrụ dị ebube na ngalaba niile, ọrụ ozi, otu, na ndị otu ọgbakọ anyị.',
    ha: 'Ya Ubangiji, ka sake hura wutar farkawa da manyan aiyuka a duk sashe, hidima, ƙungiyoyi, da bangarorin ikilisiyarmu.',
  },
  'daily-8': {
    yo: 'Àdúrà fún àwọn olórí wa: Olúwa, fi agbára fún àwọn olórí wa ní gbogbo ipele láti di olùṣe iṣẹ́ àgbàyanu.',
    ig: 'Ekpere maka ndị ndu anyị: Onyenwe anyị, nye ndị ndu anyị ike n\'ọkwa niile ka ha bụrụ ndị na-arụ ọrụ dị irè.',
    ha: 'Addu\'a don shugabanninmu: Ya Ubangiji, ka ƙarfafa shugabanninmu a kowane mataki su zama wakilai masu inganci.',
  },
  'daily-9': {
    yo: 'Ìjí-pípadà nínú ìsìn wa: Olúwa, fẹ́ ẹ̀mí Rẹ sí gbogbo ìsìn Ọjọ́ Sunday àti ti agbedeméjì ọ̀sẹ̀.',
    ig: 'Mmụgharị na ofufe anyị: Onyenwe anyị, kuo ume gị n\'ofufe Ụka anyị niile na nke etiti izu.',
    ha: 'Farkawa cikin ibadarmu: Ya Ubangiji, ka huri sallar Lahadi da ta tsakiyar mako duka.',
  },
  'daily-10': {
    yo: 'Ìpolówó Ọkà Ìbáṣepọ̀ Ìlú Ìhìnrere.',
    ig: 'Mkpọ Mkpụrụ nke Nhazi Obodo Ozi Ọma.',
    ha: 'Yaƙin Iri don Haɗin Gwiwar Birnin Bishara.',
  },
  'daily-11': {
    yo: 'Ìdásí àtọ̀runwá fún àwọn àpọ̀n àti àwọn tọkọtaya tí ń dúró.',
    ig: 'Nbiakwute nke Chineke maka ndị tozuru etozu na-amaghị di na nwunye na ndị di na nwunye na-eche.',
    ha: 'Sa hannun Allah ga manyan da ba su yi aure ba da ma\'aurata masu jiran albarka.',
  },
  'daily-12': {
    yo: 'Ààbò pípé, ìpèsè àti ìpamọ́ fún gbogbo ọmọ GOFAMINT káàkiri ayé ní 2026 àti lẹ́yìn náà.',
    ig: 'Nchedo zuru oke, nnyemaka na nchekwa maka ndị otu GOFAMINT niile n\'ụwa niile na 2026 na n\'ihu.',
    ha: 'Cikakken kariya, samarwa da kiyayewa ga dukan membobin GOFAMINT a duk duniya a 2026 da gaba.',
  },
  'daily-13': {
    yo: 'Ìdásí ìṣẹ̀mí ní àwọn àkókò ìṣòro nínú iṣẹ́-míṣọ̀nù wa káàkiri ayé.',
    ig: 'Nbiakwute nke ọrụ ebube n\'oge ihe ike na ozi anyị n\'ụwa niile.',
    ha: 'Sa hannun mu\'ujiza a lokutan wahala cikin manufanmu a duk duniya.',
  },
  'daily-14': {
    yo: 'Yíyanjú àwọn ìṣòro wa àti ìpèsè fún gbogbo àìní wa.',
    ig: 'Idozi nsogbu anyị na inye mkpa anyị niile.',
    ha: 'Warware matsalolinmu da biyan dukan bukatunmu.',
  },
  'daily-15': {
    yo: 'Bí a ṣe ń borí àwọn ohun tí ń dín ayanmọ́ kù: ọ̀lẹ, àìmọ̀, ìṣòro, àti àfàjì.',
    ig: 'Imeri ihe na-akpa nzọrọ ọnọdụ: umengwụ, amaghị, akụkụ ụkwụ, na ịgbanahụ.',
    ha: 'Cin nasara a kan abubuwan da ke ɓata kaddara: kasala, jahilci, ƙarancin gwaninta, da jinkirtawa.',
  },
  'daily-16': {
    yo: 'Iṣẹ́ Míṣọ̀nù Inú-ilé: Ìfa-ìpẹ̀-kùn ńlá, ìyára àtọ̀runwá, ìpèsè ọ̀pọ̀lọpọ̀ àti ààbò áńgẹ́lì.',
    ig: 'Ozi Ụlọ: Mkpepu dị ukwuu, ngwa ngwa nke Chineke, nnyemaka zuru oke, na nchedo nke ndị mmụọ ozi.',
    ha: 'Aikin Bishara cikin Gida: Babban nasara, saurin Allah, samar da kowa, da kariyar mala\'iku.',
  },
  'daily-17': {
    yo: 'Operation 2030: Iṣẹ́-míṣọ̀nù ńlá ti ìjàwèrè ọkàn, dídi ìjọ, àti ìmúgbára Ìjọba Ọlọ́run.',
    ig: 'Operation 2030: Ozi dị ukwuu nke ịzụta mkpụrụ obi, ịkụ ụlọ ụka, na ịkwalite Alaeze Chineke.',
    ha: 'Operation 2030: Babbar manufar yin yaƙin ruhi, dasa ikilisiyoyi, da ƙaƙwalwar Mulkin Allah.',
  },
  'daily-18': {
    yo: 'Olúwa, jẹ́ kí Áfríkà di ìkórè fún Ọ.',
    ig: 'Onyenwe anyị, mee ka Afrịka bụrụ ọrụ owuwe ihe ubi maka Gị.',
    ha: 'Ya Ubangiji, ka bar Afirka ta zama girbi gareka.',
  },
  'daily-19': {
    yo: 'Olùṣàkóso Gbogbogbòò wa, Pastor E. O. Abina: Ìṣípayá ńlá, ìṣọ́na àìmọ̀dán, àti àtúnṣe.',
    ig: 'Onyeisi anyị, Pastor E. O. Abina: Mkpughe dị ukwuu, nduzi pụrụ iche, na nhazi ọzọ.',
    ha: 'Babban Mai Kula da mu, Pastor E. O. Abina: Babban hange, jagora ta musamman, da sake daidaitawa.',
  },
  'daily-20': {
    yo: 'Agbára, ìgbàra, àti ìtara láti wàásù Jésù pẹ̀lú àmì àti iṣẹ́ ìyanu; mímú àwọn ọkàn wá sí Ìjọba Rẹ̀.',
    ig: 'Ike, obi ike, na ọkụ iji kwusaa Jisọs site n\'ihe ịrịba ama na ọrụ ebube; iweta mkpụrụ obi n\'Alaeze ya.',
    ha: 'Iko, ƙarfin hali, da ƙwazo don yin bisharar Yesu da alamu da mu\'ujizai; kawowa raidoji cikin Mulkinsa.',
  },
  'daily-21': {
    yo: 'GOFAMINT ní Yúróòpù, Éṣíà, àti Áúsírélíà.',
    ig: 'GOFAMINT na Europe, Asia, na Australia.',
    ha: 'GOFAMINT a Turai, Asiya, da Ostiraliya.',
  },
  'daily-22': {
    yo: 'Yíyọ àwọn ìdènà sí ìdàgbàsókè ìjọ tí kò ní àfọwọ́sí ní GOFAMINT.',
    ig: 'Iwepu ihe mgbochi mmụba ọgbakọ nke a na-apụghị ịkwụsị na GOFAMINT.',
    ha: 'Cire abubuwan da ke hana ci gaban ikilisiya wanda ba a iya tsayar da shi a cikin GOFAMINT.',
  },
  'daily-23': {
    yo: 'GOFAMINT ní Àríwá àti Gúúsù Amẹ́ríkà.',
    ig: 'GOFAMINT na North America na South America.',
    ha: 'GOFAMINT a Arewacin Amurka da Kudancin Amurka.',
  },
  'daily-24': {
    yo: 'Àwọn ọ̀dọ́ àti ọmọ ilé-ìwé GOFAMINT: kópa nínú ìjí-pípadà tòótọ́ kí o sì fa iṣẹ́ àgbàyanu ńlá.',
    ig: 'Ndị ntorobịa na ụmụ akwụkwọ GOFAMINT: keta na mmụgharị nke ezi okwu, dọta ọrụ dị ebube.',
    ha: 'Matasa da ɗalibai na GOFAMINT: shiga cikin farkawa ta gaskiya kuma jawo manyan aiyuka.',
  },
  'daily-25': {
    yo: 'Olúwa, gbé àwọn olówó tí ń ronú nípa ọ̀run, tí ń bọ̀wọ̀ fún Ọlọ́run àti tí ń ṣe sàásàn ní GOFAMINT.',
    ig: 'Onyenwe anyị, kpọlite ndị inye ego nke obi ha dị n\'eluigwe, na-asọpụrụ Chineke, na-aguzosi ike na GOFAMINT.',
    ha: 'Ya Ubangiji, ka tashe masu hannu da shuni masu tunani na sama, masu girmama Allah a cikin GOFAMINT.',
  },
  'daily-26': {
    yo: 'Àwọn ọmọ Ìgbìmọ̀ Aláṣẹ: pípín èrò àti ìtara fún ìjàwèrè ọkàn pẹ̀lú Olùṣàkóso Gbogbogbòò.',
    ig: 'Ndị otu Kansụl Nchịkọta: ikere ọkụ na uche ịzụta mkpụrụ obi anyị nke Onyeisi.',
    ha: 'Membobin Majalisar Zartarwa: tarayya cikin tunani da ƙwazo na yin yaƙin ruhi tare da Babban Mai Kula.',
  },
  'daily-27': {
    yo: 'Bíbọ̀wọ̀ fún àti àtìlẹ́yìn àwọn bàbá àti ìyá wa tí ó ti fẹ̀hìntì.',
    ig: 'Ịsọpụrụ na ịkwado ndị nna na ndị nne anyị ndị ezumike nká.',
    ha: 'Girmamawa da goyon bayan ubanninmu da iyayenmu mata da suka huta.',
  },
  'daily-28': {
    yo: 'Àánú ńlá àti àtìlẹ́yìn àtọ̀runwá fún àwọn ìdílé Olùṣàkóso Gbogbogbòò ìpilẹ̀ àti àwọn olórí mìíràn.',
    ig: 'Amara dị ukwuu na nkwado nke Chineke maka ezinụlọ Onyeisi mbụ anyị na ndị ndu ndị ọzọ.',
    ha: 'Babban alheri da goyon bayan Allah ga iyalan Babban Mai Kula na farko da sauran shugabanni.',
  },
  'daily-29': {
    yo: 'Náìjíríà yóò dìde lẹ́ẹ̀kan sí i: ìpè sí ìronúpìwàdà orílẹ̀-èdè àti ìdásí àtọ̀runwá.',
    ig: 'Naịjirịa ga-ebilite ọzọ: oku maka nchegharị obodo na nbiakwute nke Chineke.',
    ha: 'Nijeriya za ta sake tashi: kira don tuba ta ƙasa da sa hannun Allah.',
  },
  'daily-30': {
    yo: 'Ìgbádùn àkókò ìjí-pípadà ńlá àti iṣẹ́ àgbàyanu ńlá.',
    ig: 'Ịnụ ụtọ oge mmụgharị dị ukwuu na ọrụ dị ebube ukwuu.',
    ha: 'Jin daɗin lokacin babban farkawa da manyan aiyuka.',
  },

  // ── Vigils ────────────────────────────────────────────────────────────────
  'family_vigil-1': {
    yo: 'Ìṣẹ́gun lórí àwọn ìṣòro ìdílé àti àwọn ìjà inú ilé.',
    ig: 'Mmeri n\'elu nsogbu ezinụlọ na ọgụ ụlọ.',
    ha: 'Nasara a kan matsalolin iyali da fadan gida.',
  },
  'family_vigil-2': {
    yo: 'Sọ wá sọ̀tun lẹ́ẹ̀kan sí i, Olúwa, kí o sì sọ wá di ìbùkún fún ìran wa.',
    ig: 'Tugharia anyị ọzọ, Onyenwe anyị, mee anyị ngọzi nye ọgbọ anyị.',
    ha: 'Ka sake mai da mu, Ya Ubangiji, ka mai da mu albarka ga tsararranmu.',
  },
  'family_vigil-3': {
    yo: 'Ìdílé mi, dìde, tàn, kí o sì ṣe iṣẹ́ àgbàyanu ńlá.',
    ig: 'Ezinụlọ m, bilie, mụọ, ma rụọ ọrụ dị ebube.',
    ha: 'Iyalina, ka tashi, ka haskaka, ka aikata manyan aiyuka.',
  },
  'youth_vigil-1': {
    yo: 'Tú ọjọ́-iwájú rẹ sílẹ̀ kúrò nínú ọgbẹ ìgbé-ayé aláìbọ̀wọ̀ fún Ọlọ́run àti aláìṣe-déédéé.',
    ig: 'Tọhapụ ọdịnihu gị site na ọrịa ndụ enweghị Chineke na nke ada-eme nke oge a.',
    ha: '\'Yantar da makomarka daga ɓata na rayuwar marar Allah da makaurutawa ta zamani.',
  },
  'women_vigil-1': {
    yo: 'Tútù àwọn iṣẹ́ Sátánì kúrò nínú ìjọ àti ilé wa.',
    ig: 'Ihopu ọrụ Setan n\'ọgbakọ na ụlọ anyị.',
    ha: 'Tumɓuke ayyukan Shaiɗan daga ikilisiya da gidajenmu.',
  },
  'men_vigil-1': {
    yo: 'Mímú àwọn ilé àti ìjọ wa lágbára lòdì sí gbogbo ọ̀nà ìfa ayé àti Sátánì, ìkọlù, àti ètè.',
    ig: 'Iwusi ụlọ anyị na ọgbakọ ike megide ụzọ niile nke uwa na Setan, mwakpo, na nzube.',
    ha: 'Ƙarfafa gidajenmu da ikilisiyoyinmu daga dukan hanyoyin jaraba na duniya da na Shaiɗan, hare-hare, da makirci.',
  },
  'general_vigil-1': {
    yo: 'Yíyanjú àwọn ìdènà tó hàn àti tí ó pamọ́ tó ń dí wa lọ́wọ́ ìjí-pípadà ńlá àti iṣẹ́ àgbàyanu.',
    ig: 'Idozi ihe mgbochi pụtara ìhè na ndị zoro ezo na-egbochi anyị mmụgharị dị ukwuu na ọrụ dị ebube.',
    ha: 'Magance abubuwa masu fitowa da na ɓoye da ke hana mu farkawa mai girma da manyan aiyuka.',
  },
};

// ── Apply the dictionary to the JSON ─────────────────────────────────────────

function main() {
  const raw = fs.readFileSync(JSON_PATH, 'utf8');
  const data = JSON.parse(raw);

  // 1. Book metadata
  data.book.translations = {
    ...(data.book.translations || {}),
    ...BOOK_TRANSLATIONS,
  };

  // 2. Per-entry translations
  let touched = 0;
  for (const entry of data.entries) {
    entry.translations = entry.translations || {};
    const key = `${entry.entry_type}-${entry.entry_number}`;

    // Day 1: full coverage
    if (entry.entry_type === 'daily' && entry.entry_number === 1) {
      entry.translations = mergeLangBlock(entry.translations, DAY_1);
      touched++;
      continue;
    }

    // Everything else: focus (and scripture/intercession only where we have them)
    const focus = FOCUS_BY_ENTRY[key];
    if (focus) {
      for (const lang of Object.keys(focus)) {
        entry.translations[lang] = entry.translations[lang] || {};
        entry.translations[lang].focus = focus[lang];
      }
      touched++;
    }
  }

  // 3. Document what's translated vs needs review (for humans reading the file)
  data._translation_status = {
    generated_at: new Date().toISOString(),
    coverage: {
      book_metadata:       'yo, ig, ha — full (title, subtitle, description)',
      day_1:               'yo, ig, ha — full (focus, scripture, message, prayer_points, intercession)',
      daily_2_through_30:  'yo, ig, ha — focus only',
      vigils:              'yo, ig, ha — focus only',
      remaining_fields:    'inspirational_message + prayer_points + scripture_text + special_intercession for days 2-30 and all vigils — to be filled in by the language committee via the maindashboard Victory Month editor',
    },
    note:
      'Translations supplied by an AI-assisted starter pass. They are intended as a working baseline ' +
      'and should be reviewed by native Yorùbá / Igbo / Hausa speakers before publishing. ' +
      'Add or correct any field directly in the admin dashboard — translations round-trip through the ' +
      'POST /api/admin/books/:id/entries endpoint and persist to the book_entries.translations JSONB column.',
  };

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');

  console.log(`[translations] book metadata: ${Object.keys(data.book.translations).join(', ')}`);
  console.log(`[translations] touched ${touched}/${data.entries.length} entries`);
  console.log('[translations] done. Run `node scripts/seed-victory-month.js` to push to the DB.');
}

function mergeLangBlock(target, additions) {
  const out = { ...(target || {}) };
  for (const lang of Object.keys(additions)) {
    out[lang] = { ...(out[lang] || {}), ...additions[lang] };
  }
  return out;
}

main();
