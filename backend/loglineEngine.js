/**
 * loglineEngine.js
 * Procedural logline generator — no LLM required.
 * Combines randomized slot pools for each genre to produce unique loglines.
 * With 4+ templates × 15–20 options per slot = thousands of unique combos per genre.
 */

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOT POOLS BY GENRE
// ─────────────────────────────────────────────────────────────────────────────

const SLOTS = {

  // ── ROMANCE ──────────────────────────────────────────────────────────────
  Romance: {
    heroines: [
      "a penniless event planner drowning in her late father's debts",
      "a brilliant but overlooked assistant at the city's most powerful law firm",
      "a disgraced surgeon trying to rebuild her career after a false accusation",
      "a single mother juggling two jobs and hiding a devastating secret",
      "a country girl who inherits her grandmother's crumbling boutique hotel",
      "a burned-out journalist assigned to profile the one man she despises",
      "a fiercely independent restaurant owner one missed payment from losing everything",
      "a grieving widow hired as a live-in nanny for a cold billionaire's daughter",
      "a spirited art restorer who accidentally authenticates a forgery",
      "a struggling fashion designer whose work is stolen by her former mentor",
      "a sharp-tongued divorce lawyer who swore she'd never believe in love",
      "a barely-surviving nurse who wins a weekend stay at an elite mountain retreat",
      "a loyal secretary who discovers her boss has been covering up a massive fraud",
      "a determined intern at the city's most cutthroat investment bank",
      "a quietly brilliant librarian hiding a double life no one suspects",
      "a headstrong architect assigned to renovate her childhood home—now owned by a stranger",
      "a wedding planner who has never been the bride and swore she never would be",
      "a bookshop owner one bad lease renewal from losing everything she built",
      "a recently fired marketing exec who accidentally ends up on the wrong flight—to the wrong city",
      "a personal chef hired by a man who has never once said thank you",
    ],
    coldLeads: [
      "the ruthless CEO who just acquired her employer and has no intention of keeping her on",
      "a cold-blooded billionaire who proposed to her as part of a business arrangement—not a romance",
      "the icy heir to a luxury empire who chose her for a contract marriage at random",
      "the powerful man who ruined her father's company without ever learning her name",
      "a brooding property mogul who owns her building and wants her out of it",
      "the untouchable corporate raider who shows up as the unexpected investor saving her business",
      "the cold, brilliant attorney who represents the family suing her into bankruptcy",
      "an influential media baron who bought the magazine that fired her—and then hired her back",
      "the stone-faced financier who holds her dead father's debts and has come to collect",
      "a commanding shipping magnate who needs a temporary wife—strictly for appearances",
      "the infuriatingly composed CEO who acquired her startup for nothing and kept only her",
      "a calculating tech billionaire whose algorithm determined she's his most compatible match",
      "the cold-eyed architect of everything wrong in her life who walks in like he owns the place—because he does",
      "a powerful board chairman who needs a credible companion and chose her from a dossier",
      "the icy surgeon who oversees the hospital threatening to shut down her ward",
    ],
    incitingEvents: [
      "a single impulsive signature binds them together for one year",
      "a misdelivered letter sets off a chain of consequences neither can undo",
      "a forgotten clause in her father's will puts her future in his hands",
      "a viral photo of the two of them makes them the internet's accidental couple",
      "a corporate merger forces her directly into his orbit with no escape clause",
      "she signs a contract she didn't read carefully enough",
      "a staged relationship she agreed to becomes dangerously real",
      "a business trip gone wrong traps them together for forty-eight hours",
      "a debt she inherited means she works for him now—whether she likes it or not",
      "a bet he made about her before they met resurfaces at the worst possible moment",
      "a convenience marriage neither wanted somehow produces feelings neither planned",
      "her best friend's wedding puts them in the same wedding party for an entire week",
      "a mistaken identity at a charity gala launches an arrangement built on the wrong assumption",
      "an overheard conversation changes everything she thought she knew about him",
      "one impulsive lie to save face becomes the foundation of a six-month charade",
    ],
    complications: [
      "but his ex-fiancée is determined to reclaim him",
      "but the closer she gets the clearer it becomes that he's hiding something dangerous",
      "but the family secret she's been keeping could end everything",
      "yet her heart refuses to follow the terms of their agreement",
      "while a rival plots to use her as leverage against him",
      "as his cold exterior develops cracks she never expected",
      "but someone from her past is determined to expose the arrangement",
      "while her growing feelings are the one thing their contract never accounted for",
      "but falling for him was never part of the plan—and now it's too late",
      "as the lies stacking between them grow harder to undo",
      "while the media scrutiny around them turns every private moment into a public risk",
      "but she's not the only one pretending this arrangement is strictly business",
    ],
    stakes: [
      "she must protect her family from financial ruin",
      "everything she's rebuilt is on the line",
      "her independence—and her heart—hang in the balance",
      "the business she sacrificed everything for is at stake",
      "she risks losing the one future she's carefully planned",
      "both their reputations—and something far more fragile—are at risk",
      "the family secret she's guarded for years could surface at the worst moment",
      "her chance at a real life could disappear the moment the truth comes out",
    ],
  },

  // ── DRAMA ────────────────────────────────────────────────────────────────
  Drama: {
    heroines: [
      "a cast-out heiress determined to reclaim her family's stolen legacy",
      "a wrongfully disgraced surgeon rebuilding her name at a rival hospital",
      "a sharp politician's aide who uncovers corruption at the very top",
      "a brilliant lawyer whose career is upended when her own firm betrays her",
      "a forensic accountant who stumbles onto a billion-dollar cover-up",
      "a tenacious investigative reporter closing in on a story that could get her killed",
      "an ambitious executive who realizes the empire she built is built on lies",
      "a daughter who returns home after ten years to find nothing is as it was",
      "a celebrated chef whose empire crumbles the moment a ruthless critic arrives",
      "a whistleblower who escapes with the one file that can bring down a dynasty",
      "a family matriarch who discovers her husband's decades-long double life",
      "a retired detective pulled back in when the case she closed turns out to be wrong",
      "a celebrated actress whose comeback role forces her to confront the person who destroyed her",
      "a chief of staff who discovers the senator she serves is a fraud",
      "a social worker navigating systemic corruption to protect the one family she can't abandon",
    ],
    coldLeads: [
      "the ruthless chairman her father trusted—until he took everything",
      "the powerful CEO her family sold their legacy to when they had no choice",
      "the cold-blooded prosecutor who built his career on cases like hers",
      "the influential board director who signed off on her destruction without a second thought",
      "the calculating politician whose rise came directly at her family's expense",
      "a distant billionaire investor who holds the debt—and the leverage—to finish what he started",
      "a corporate titan whose name is on every piece of paper that ruined her life",
      "the composed media magnate who controls the narrative she's trying to change",
      "the former ally who chose power over loyalty and has been managing the fallout ever since",
      "an uncompromising investigator assigned to discredit her before she gets too close to the truth",
    ],
    incitingEvents: [
      "a sealed document surfaces that changes the official story entirely",
      "the death of a key witness she was counting on forces her to change strategy",
      "a chance encounter with the one person she swore she'd never speak to again",
      "an anonymous tip leads her to evidence she was never meant to find",
      "a promotion she earned lands her directly in the orbit of the man who ruined her family",
      "a family emergency pulls her back into the world she left and will not release her",
      "the unexpected reading of a will rewrites the power structure of everything she knew",
      "a public accusation forces her to either run or fight the most powerful people in the room",
      "an alliance she trusted fractures at the worst possible moment",
      "the evidence she spent years building disappears overnight—and she has to start over",
    ],
    complications: [
      "but the deeper she digs the more dangerous the people closing in become",
      "while the man she now has to trust is the last one she ever wanted to depend on",
      "but the truth she's uncovering puts the people she loves in the crossfire",
      "as the alliances she relied on shift in ways she didn't predict",
      "but bringing him down means exposing secrets that could destroy her own family too",
      "while someone is carefully ensuring she never gets close enough to finish what she started",
      "yet the evidence she needs is in the hands of the one man she refuses to ask",
      "as her window to act closes faster than she anticipated",
    ],
    stakes: [
      "her family's name and everything attached to it hangs in the balance",
      "justice for the people who trusted her is the only outcome she'll accept",
      "the truth she's uncovered is the only thing standing between his next victim and him",
      "everything she gave up to get here means nothing if she fails now",
      "the power she's built is only as strong as the secret no one else must find",
    ],
  },

  // ── ACTION ───────────────────────────────────────────────────────────────
  Action: {
    heroines: [
      "a disavowed intelligence officer framed for her partner's murder",
      "a retired special forces medic living quietly until they come for her",
      "a cyber-security analyst who accidentally witnesses a government assassination",
      "a brilliant detective who goes rogue after justice fails her sister",
      "a mercenary hired to protect the one man she was paid to eliminate",
      "a former Interpol agent whose cover is blown on her first civilian job",
      "a stunt double who discovers the actress she's protecting is the real target",
      "an undercover officer so deep in the game she's forgotten which side she's on",
      "a bomb disposal tech who realizes the last device she defused was planted by someone inside",
      "a bounty hunter chasing a fugitive who turns out to be the only witness to a massacre",
      "a private security contractor assigned to guard the man who destroyed her family",
      "a sharpshooter-for-hire who refuses one job—until they use her daughter as leverage",
      "a fugitive ex-soldier carrying encrypted intel that three governments want back",
      "a war correspondent embedded with the wrong unit at exactly the wrong moment",
      "a forensic specialist turned field operative after her lab is firebombed mid-investigation",
    ],
    coldLeads: [
      "the cold handler who burned her career and now needs her for the job no one else will take",
      "a ruthless operative assigned to bring her in—dead or alive, his choice",
      "the commanding officer who gave the order that destroyed everything she had",
      "a calculating intelligence director who knows exactly where she is and exactly what she knows",
      "the legendary mercenary whose name is on a kill list she wasn't supposed to find",
      "a composed billionaire arms dealer who claims he's on her side—for now",
      "the icy director of the agency hunting her who may be the only one who can clear her name",
      "a dangerous asset she's been ordered to protect who is far more than what the file says",
      "the unyielding field commander whose mission objectives conflict with every choice she makes",
      "a former partner who chose the wrong side and is now the most dangerous person in the operation",
    ],
    incitingEvents: [
      "she is activated for a mission that was never supposed to exist",
      "a kill order with her name on it surfaces inside her own agency",
      "she witnesses something classified and has forty-eight hours before they close the gap",
      "a handler she trusted drops off the grid and leaves a single encrypted message",
      "the target she's been tracking turns himself in—and asks for her specifically",
      "a raid goes wrong and she's the only one who walked out alive",
      "classified files are leaked with her identity exposed on page one",
      "an operation she ran three years ago comes back with consequences she wasn't briefed on",
      "a dead operative's last transmission leads her to a conspiracy bigger than the mission",
      "she's framed for the assassination of someone she was protecting",
    ],
    complications: [
      "but the one man who can clear her name is the one she can't afford to trust",
      "while the clock runs out on the only window she has to prove her innocence",
      "but every lead she follows has already been sanitized by someone with more clearance",
      "as the threat closes in on the civilians she didn't plan on caring about",
      "while every agency she once worked for is now working against her",
      "but the man beside her has his own orders—and hers aren't on the list",
    ],
    stakes: [
      "the truth dies with her if she can't get it out in time",
      "everyone who helped her becomes a target the moment her cover breaks",
      "the mission she's running is the only thing standing between a massacre and tomorrow morning",
      "her freedom—and every name on that file—depends on finishing what she started",
    ],
  },

  // ── ADVENTURE ────────────────────────────────────────────────────────────
  Adventure: {
    heroines: [
      "a penniless explorer who inherits a cryptic map and a mountain of her grandfather's debt",
      "a marine archaeologist whose funding is cut the day she finds proof of an ancient civilization",
      "a globe-trotting journalist chasing a story that leads to the edge of the known world",
      "a skilled mountain guide hired to lead an eccentric billionaire to the summit—or off it",
      "a treasure hunter whose partner stole both the map and the credit",
      "a park ranger who discovers something impossible in the deepest part of the wilderness",
      "a rogue anthropologist following a lead the academic world insists is impossible",
      "a cartographer mapping a disputed border who stumbles onto a decades-old secret",
      "a wildlife biologist tracking a species that should be extinct",
      "a former expedition leader forced back into the field by the one person she'll never forgive",
      "an amateur cave diver who drops into a system with its own ecosystem—and its own rules",
      "a solo sailor blown off course into waters controlled by the wrong people",
      "a survival trainer hired for a reality show that quickly becomes anything but reality",
      "a relic restorer hired to assess a private collection that turns out to be anything but private",
      "a deep-sea rescue diver pulled into a classified recovery operation miles below the surface",
    ],
    coldLeads: [
      "the arrogant billionaire explorer who owns the expedition and intends to own the discovery too",
      "the cold-eyed rival archaeologist racing her to the same site by different means",
      "the commanding ex-military guide assigned to keep her alive—against her wishes",
      "an expedition funder whose real agenda has nothing to do with history",
      "the ruthless collector who has been one step behind her for three expeditions",
      "a calculating government operative embedded in her team without her knowledge",
      "the icy maritime authority who holds the permits she needs and wants something in return",
      "a composed rival who already has half the map and needs the half she's carrying",
      "the expedition's silent financial backer whose terms only become clear mid-journey",
      "a legendary explorer who supposedly died on the last expedition—and very much did not",
    ],
    incitingEvents: [
      "a dying rival passes her a set of coordinates and one instruction: don't tell anyone",
      "she discovers her grandfather's journal contains a location that experts declared impossible",
      "a commission to verify a forgery leads her to an artifact that shouldn't exist",
      "the foundation funding her work is shut down overnight—and someone made that call",
      "a map she dismissed as fiction turns out to match a landscape no satellite has ever imaged",
      "the one person she trusted with the discovery vanishes twenty-four hours later",
      "she's hired to retrieve something lost and realizes the thing never wanted to be found",
      "a storm strands her exactly where every compass in her pack starts behaving wrong",
      "a deathbed confession from her mentor changes everything she believed about her field",
      "an anonymous package arrives with flight coordinates and a warning not to bring anyone",
    ],
    complications: [
      "but the route ahead is controlled by people who do not want the discovery made public",
      "while the man beside her has his own claim to what they're looking for",
      "but getting there requires trusting someone whose motives she cannot read",
      "as the environment itself becomes the most dangerous variable",
      "while a rival team is already ahead of them and playing without rules",
      "but the discovery is only the beginning—getting it out is the harder problem",
    ],
    stakes: [
      "the discovery would rewrite history—and someone is prepared to bury it instead",
      "the people financing the expedition want what she finds, not who she is",
      "the only way home runs straight through the thing they came to find",
      "her reputation, her mentor's legacy, and the expedition's survival ride on what comes next",
    ],
  },

  // ── CRIME ────────────────────────────────────────────────────────────────
  Crime: {
    heroines: [
      "a sharp-eyed forensic accountant who follows the money straight into a war zone",
      "a public defender who realizes her client is innocent—and someone powerful needs him convicted",
      "a cold-case detective reopening the one file the department buried",
      "an ex-con trying to go straight who is blackmailed back into the life",
      "an insurance investigator whose routine claim leads to a criminal empire",
      "a criminologist hired to profile a killer who may be inside her own office",
      "a crime-beat reporter who becomes the story when she witnesses the hit",
      "a forensic specialist whose evidence is tampered with—and someone in the lab did it",
      "a federal prosecutor who gets too close to the truth and ends up on the defendant's side of the table",
      "a seasoned detective whose partner was dirty—and now everyone assumes she is too",
      "a cybercrime analyst who traces a billion-dollar heist to someone in her own building",
      "a judge whose ruling triggers a credible threat against the only family she has left",
      "a witness protection handler who falls for the target she's supposed to keep hidden",
      "a police sketch artist whose work is too accurate—and now the wrong people know her name",
      "a bail bondsman who knows where the bodies are buried—literally—and can prove it",
    ],
    coldLeads: [
      "the ruthless organized crime attorney who represents the man she's trying to put away",
      "a cold-blooded investigator assigned to the same case from a competing jurisdiction",
      "the calculating district attorney who wants the conviction she's trying to stop",
      "an untouchable crime boss who, inexplicably, is the only one helping her find the truth",
      "the former detective who closed the original case and doesn't want it reopened",
      "a composed federal agent whose agenda overlaps with hers in only one direction",
      "the icy crime lord who has no reason to keep her alive—but keeps doing it anyway",
      "a calculating defense attorney who knows his client is guilty and doesn't care",
      "the disgraced ex-cop who knows the truth and is hiding from the people who don't want it told",
      "a powerful crime family patriarch who offers her protection she doesn't want",
    ],
    incitingEvents: [
      "a body turns up that matches a case file sealed for twenty years",
      "a witness recants at the last possible moment—and she doesn't believe they did it freely",
      "an anonymous package arrives at her desk containing evidence that shouldn't exist",
      "a suspect she was certain of walks free on a technicality that was manufactured",
      "her partner is killed mid-investigation and the case is closed the same day",
      "she's handed a cold case as punishment—and finds it very much still warm",
      "a routine audit reveals a financial thread that leads somewhere no one expected",
      "someone transfers her off a case the morning a key witness is found dead",
      "she receives a tip with coordinates, a time, and a warning to come alone",
      "a convicted killer sends her a letter that proves the wrong person is in prison",
    ],
    complications: [
      "but the evidence trail leads somewhere above her pay grade",
      "while the man she has to work with has his own reasons for wanting the case closed",
      "but every move she makes is being watched by someone she hasn't identified yet",
      "as the corruption she's uncovering reaches people she trusted completely",
      "while the clock on an innocent person's fate runs down faster than her investigation",
      "but the truth is more dangerous than the crime—and the people with power know it",
    ],
    stakes: [
      "justice for the victim is the only outcome she'll accept—whatever it costs her",
      "the wrong person's life is on the line and she has hours to change it",
      "her badge, her freedom, and the case all depend on the same impossible choice",
      "if she's wrong she loses everything; if she's right someone powerful loses more",
    ],
  },

  // ── HORROR ───────────────────────────────────────────────────────────────
  Horror: {
    heroines: [
      "a night-shift nurse at a psychiatric ward that has been closed for thirty years—until now",
      "a paranormal investigator who has never believed in ghosts, until tonight changes everything",
      "an urban explorer whose footage reveals she was never alone in that building",
      "a grief counselor who moves into her late mother's house and realizes the grief never left",
      "a documentary filmmaker whose subject starts documenting her back",
      "a forensic pathologist who finds physical evidence of a murder that happened in the future",
      "a sleep researcher who begins experiencing her subjects' nightmares in real time",
      "a lighthouse keeper whose predecessor's journal describes something still circling the rocks",
      "a sound engineer who discovers a frequency buried in a hundred-year-old recording",
      "a medical examiner who starts receiving messages from her most recent case",
      "a search-and-rescue volunteer whose team finds the wreck—but no one inside could have survived the impact",
      "a woman who wakes from a coma to find the world moved on without her—mostly",
      "a remote cabin rental host who finds the same carving in every room: a date. Tomorrow's.",
      "a paleontologist who realizes the creature she unearthed was not as extinct as the records said",
      "a crisis negotiator called in to talk down someone who knows things she was never told",
    ],
    coldLeads: [
      "the cold, composed detective assigned to a case that keeps happening to people close to her",
      "a controlled psychiatrist who knows more about her symptoms than any diagnosis should allow",
      "the distant property owner who knew what the building was before she signed the lease",
      "a calculating researcher who has been monitoring the phenomenon she stumbled into",
      "the unreadable figure who keeps appearing at the edge of every investigation she runs",
      "a composed archivist who treats the supernatural as a filing problem and her as a variable",
      "the icy administrator who approved her transfer to the location—and won't say why",
      "a former occupant who disappeared from the same address eighteen months ago and just turned up",
      "the cold specialist brought in to contain something she was never meant to encounter",
      "a detached academic who has published three papers on exactly what she's experiencing",
    ],
    incitingEvents: [
      "a routine inspection of the closed facility reveals it was never fully emptied",
      "the recording she reviews contains audio that couldn't have been captured by her equipment",
      "a patient's impossible knowledge breaks every rational explanation she has left",
      "her predecessor's notes end mid-sentence on the same date she arrived",
      "a child draws a picture of her standing in a place she has never been—yet",
      "the medical scan returns results that are physically impossible",
      "a symbol she photographed in one location appears in three others she visited the same day",
      "the building's floor plan doesn't match the number of rooms she's counted",
      "every rational explanation she finds has already been ruled out in the file—by someone else",
      "she wakes up in a location she has no memory of reaching",
    ],
    complications: [
      "but the rational explanation she's holding onto is running out of room",
      "while the one person who might believe her has every reason not to",
      "as the boundary between what's happening and what's impossible continues to dissolve",
      "but leaving is no longer as simple as it was when she arrived",
      "while whatever is here seems to know more about her than she knows about it",
      "as the events accelerate in ways her training gave her no framework for",
    ],
    stakes: [
      "survival is no longer guaranteed—and neither is her grip on what's real",
      "the truth is survivable only if she reaches it before it reaches her",
      "everyone who came before her left or disappeared; she intends to be the exception",
      "the answers she's closing in on come with a cost she hasn't calculated yet",
    ],
  },

  // ── FANTASY ──────────────────────────────────────────────────────────────
  Fantasy: {
    heroines: [
      "a hedge witch with no magic of her own who discovers she can unmake spells others cast",
      "a disgraced court scribe who copies the one forbidden manuscript and unleashes what's inside",
      "a mortal girl sold to the fae court as a debt settlement who refuses to stay bought",
      "a healer in a war-torn kingdom who learns her gift is actually a curse",
      "a smuggler who discovers the artifact she's carrying is alive",
      "a cursed princess who has lived a hundred lives and remembers every one of them",
      "a mage's apprentice whose master dies before telling her what she really is",
      "a soldier who survives the battle that killed everyone else—and needs to understand why",
      "a keeper of the dead who realizes one of her charges is not entirely gone",
      "a scholar who translates a prophecy and realizes it's about her—and it's already begun",
      "a village girl chosen by a god who very clearly chose the wrong person",
      "a former knight stripped of her title who is given one last chance by the worst possible patron",
      "an archivist in a library that holds books not yet written",
      "a blacksmith's daughter who forges a blade that can cut fate itself",
      "a royal cartographer mapping territories that officially don't exist",
    ],
    coldLeads: [
      "the cold-blooded fae lord who purchased her contract and has no intention of releasing it",
      "an immortal warlord who recognizes her power before she does—and intends to control it",
      "the ruthless crown prince who needs her gift to win a war she wants no part of",
      "a calculating sorcerer whose plans span centuries and she just became a necessary piece",
      "the icy commander of an enemy army who offers alliance instead of battle—for now",
      "a composed necromancer whose motives are older than the kingdom and harder to read",
      "the cold, legendary warrior whose curse is tied to the same prophecy that named her",
      "an ancient court figure who has outlived every person who ever tried to refuse him",
      "the distant sovereign of a rival kingdom who needs something only she can provide",
      "a ruthless archmage who destroyed his own heart to gain power—and recognizes something in her that unsettles him",
    ],
    incitingEvents: [
      "a forbidden spell she was never supposed to cast tears a hole in the order of things",
      "a creature bound for centuries escapes the moment her blood touches the seal",
      "the prophecy carved above the throne room door rearranges itself to spell her name",
      "a dying oracle passes her a token and a single word she won't understand until it's too late",
      "the gift she's hidden since childhood activates without warning in front of the wrong audience",
      "a bargain struck by her ancestor binds her to a court she didn't know existed",
      "the map she's been copying leads to a location every other version of the map omits",
      "a magical trial meant to eliminate her fails in a way no one has ever seen before",
      "the relic she was transporting activates—and chooses her as its bearer",
      "an assassin sent to kill her stops mid-mission and swears an oath she never asked for",
    ],
    complications: [
      "but the power she's inherited comes with a cost the old texts deliberately obscured",
      "while the man she must work alongside has centuries of reasons not to trust anyone",
      "but the prophecy names both her victory and the price she'll pay for it",
      "as the magic reshaping around her is older and less predictable than anyone warned",
      "while every faction in the kingdom wants to use her before the others can",
      "but the alliance she needs requires trust she hasn't decided to give",
    ],
    stakes: [
      "the realm survives only if she masters what she's carrying before it masters her",
      "the bargain she's been handed cannot be broken—only fulfilled or paid for in blood",
      "the prophecy ends in one of two ways and she is the only variable that changes which",
      "the power she holds is the last thing standing between the kingdom and what's coming",
    ],
  },

  // ── MONSTER ──────────────────────────────────────────────────────────────
  Monster: {
    heroines: [
      "a wildlife biologist whose field notes stop matching anything in the known record",
      "a rural sheriff whose town has been losing livestock—and now it's losing people",
      "a cryptid researcher whose best lead pays off the same week her grant runs out",
      "a park ranger who has been covering for three years because no one would believe the truth",
      "a trauma surgeon airlifted to a logging camp to find the crew barricaded against something outside",
      "a documentary host whose failing show captures something real—and now she can't stop",
      "a folklorist who realizes the legends she studies are incident reports written in metaphor",
      "a marine biologist who surfaces from a deep dive having lost two hours and gained something else",
      "a demolition contractor who breaks through a wall and finds a room sealed from the inside",
      "a game warden investigating kills that no native predator could physically explain",
      "a cave diver mapping a new system who finds tool marks on the wall made from the inside",
      "a soil scientist whose core samples return from the lab with something still alive inside",
      "a wilderness therapist whose group session is interrupted by something that was never supposed to be here",
      "a search-and-rescue volunteer who keeps being called to the same coordinates—different victims",
      "a lighthouse keeper whose logs describe the same creature her predecessor reported forty years ago",
    ],
    coldLeads: [
      "the cold government containment specialist who arrived before she even filed her report",
      "a calculating zoologist whose published work requires the creature not to exist",
      "the composed military officer whose team is here to recover, not disclose",
      "a ruthless corporate operative whose employer has known about this for longer than anyone admits",
      "the icy academic whose entire career is built on debunking exactly what she's just documented",
      "a detached field commander whose orders conflict directly with her survival instincts",
      "the cold-eyed liaison from an agency she doesn't have clearance to name",
      "a former researcher who left the program under circumstances he won't describe",
      "the calculating specimen collector who treats her discovery as a transaction",
      "an unreadable operative embedded in her team before she knew there was a team",
    ],
    incitingEvents: [
      "a specimen she collected triggers a response in a second specimen sealed in a lab",
      "the creature she photographed appears in a photograph taken thirty years before she was born",
      "a survivor of the original incident contacts her with evidence the official report buried",
      "something follows her back from the field—and it knew her name before she introduced herself",
      "an agency requests she hand over all her materials and orders her to forget the coordinates",
      "the remains she found don't match any species in any database—living or extinct",
      "a second researcher working independently vanishes the day after their findings aligned",
      "the behavior pattern she's documented matches reports from six other locations in six other countries",
      "a local informs her that what she's tracking has a name in the regional language—and the name is a warning",
      "the kill site she's analyzing contains evidence of tool use",
    ],
    complications: [
      "but the creature is more aware of her than any animal should be",
      "while the organization covering this up is better resourced than anything she can fight alone",
      "but the evidence she's gathered is the only thing keeping her relevant—and alive",
      "as the thing she's studying begins adjusting its behavior in response to her investigation",
      "while the people she trusted to help her are receiving calls she isn't on",
      "but the closer she gets the more she suspects the discovery is already out of her hands",
    ],
    stakes: [
      "if she's wrong the community she's alarming pays the price; if she's right so does she",
      "the evidence she's carrying is the only copy of the truth—and it is very much wanted",
      "the creature is not the most dangerous thing in this situation",
      "what comes next depends entirely on who reaches her findings first",
    ],
  },

  // ── SCIENCE FICTION ──────────────────────────────────────────────────────
  "Science Fiction": {
    heroines: [
      "a terraforming engineer on a colony world who discovers the planet was already inhabited",
      "a starship medic whose patient carries a pathogen that rewrites host memories",
      "a time-loop analyst trapped in the same catastrophic eighteen minutes with no exit protocol",
      "an AI ethicist hired to decommission a system that insists it's conscious—and can prove it",
      "a deep-space salvage pilot who boards a vessel that left port forty years ago",
      "a geneticist who discovers the human genome was edited long before science could do it",
      "a station administrator whose life support readings consistently show one more occupant than the manifest",
      "a neural interface technician who begins experiencing the memories of her clients",
      "a first-contact linguist whose translation of the signal changes everything—and not for better",
      "a clone who discovers she's not the original and the original is still alive",
      "a wormhole maintenance engineer who finds a loop that circles back to yesterday",
      "a quarantine officer on a generation ship who realizes the infection didn't come from outside",
      "a lunar archaeologist who finds a structure built before humanity reached the moon",
      "an orbital debris analyst who realizes what she's tracking isn't debris—it's a message",
      "a synthetic biologist who creates the organism she was specifically hired to prevent",
    ],
    coldLeads: [
      "the cold station commander whose mission protocol takes precedence over every human consideration",
      "a calculating AI systems architect who sees her ethical objections as an engineering problem",
      "the ruthless corporate director who owns the mission, the ship, and the discovery",
      "a composed alien diplomat whose cooperation comes with terms no one has fully translated",
      "the icy fleet admiral whose orders were written before the situation changed—and who refuses to update them",
      "a cold-blooded bio-division director who wants the pathogen more than he wants the crew",
      "a calculating temporal analyst who knows what she's going to find and refuses to warn her",
      "the controlled overseer whose calm is more unsettling than any alarm",
      "a former colleague who uploaded to a server and has opinions about her current choices",
      "a systems AI whose loyalty protocols are optimized for the mission—not the people on it",
    ],
    incitingEvents: [
      "the anomaly she was sent to classify sends back a signal that matches her own biometrics",
      "a system reboot reveals a passenger in cryosleep who was not on the original manifest",
      "the timeline she's in is version three—and she's the only one who remembers the other two",
      "first contact occurs six months ahead of every projected scenario—and without warning",
      "a routine maintenance cycle reveals a compartment that is not on any schematic",
      "the decommission order she's executing contains a last message she was never meant to read",
      "a dead crew member's log continues updating three weeks after the recorded date of death",
      "the distress signal she's following originates from a ship that was destroyed on her watch",
      "a genetic scan of the colony's water supply returns markers that are not human—and not alien",
      "the destination coordinates the ship has been following are not what anyone programmed",
    ],
    complications: [
      "but the mission parameters were never about what they told her they were about",
      "while the entity she's communicating with understands her better than her own crew does",
      "but what's on the other side of this decision cannot be undone",
      "as the systems she relies on begin prioritizing protocols she didn't authorize",
      "while the corporation funding this mission has already planned for every outcome—including her",
      "but the ethical line she's been trained to hold is dissolving the closer she gets to the truth",
    ],
    stakes: [
      "the discovery changes the species-level narrative of humanity—if she chooses to release it",
      "everyone on the station lives or dies on the decision she makes in the next twelve hours",
      "the mission she was sent to complete and the mission that actually needs completing are not the same",
      "what she knows cannot be unknown, and the people who want it buried are already moving",
    ],
  },

  // ── WEREWOLF ─────────────────────────────────────────────────────────────
  Werewolf: {
    heroines: [
      "a human nurse who relocates to a remote mountain town and realizes the locals are not entirely human",
      "an omega wolf cast out of her pack who builds a life in the human world—until they come back for her",
      "a wildlife biologist studying an anomalous wolf population who is declared an outsider witness to things no human should see",
      "a lone she-wolf whose mate bond activates with the alpha of the exact pack that exiled her family",
      "a human journalist investigating a string of disappearances that the police keep closing without explanation",
      "a rogue wolf who has survived five years without a pack—and now an alpha is claiming otherwise",
      "a pack healer whose powers only activate when the alpha she resents is near",
      "a human girl raised by wolves who discovers she was born human for a very specific reason",
      "an alpha's daughter rejected by her fated mate who builds herself into something no one can reject",
      "a half-blood wolf born without a wolf form who carries a gift her pack elders fear",
      "a she-wolf who walked away from the ranked hierarchy and is forced back when war arrives",
      "an unmated omega who accidentally bonds to the most dangerous alpha in the territory",
      "a pack enforcer who discovers the crimes she's been ordered to bury run deeper than the pack",
      "a human woman who inherits land that turns out to be sacred wolf territory",
      "a human sheriff's deputy who has been quietly managing the peace between species for years",
    ],
    coldLeads: [
      "the ruthless alpha of the dominant pack who claims her as his mate without asking her opinion",
      "a cold-blooded pack king whose authority is absolute and whose interest in her is a complication he didn't plan for",
      "the powerful rogue alpha who leads the pack that hunted her family—and now needs her alive",
      "a calculating alpha commander whose mission requires her cooperation and offers nothing in return",
      "the icy eldest son of a rival pack who is forced into a treaty that names her as the binding term",
      "a composed alpha who has rejected his mate bond for decades and cannot explain why hers is different",
      "the ruthless pack enforcer who is assigned to bring her back—and has no interest in her feelings about it",
      "a dominant alpha whose pack's survival depends on the human woman he would never have chosen",
      "the cold-eyed lone alpha building his own territory from nothing—and she stumbled into the middle of it",
      "an ancient alpha whose bloodline is the source of the curse she's just been handed",
    ],
    incitingEvents: [
      "a mate bond she didn't believe in activates the moment she crosses his territory line",
      "she witnesses a shift that no human was supposed to see—and he has to decide what to do about her",
      "an injury on pack territory binds her to their healer's oath and she cannot leave until she's settled the debt",
      "a treaty negotiation uses her as collateral before anyone asks her",
      "her blood on his hands triggers a bond that neither of them can break",
      "the pack law she violated without knowing it now puts her under his jurisdiction indefinitely",
      "a rogue attack leaves her with marks that mean something to every wolf she meets—and nothing to her",
      "she inherits a role in the pack structure that died with her grandmother and is suddenly very much alive",
      "a rival pack's aggression forces him to make a claim he wasn't ready to make",
      "the hunt she accidentally joins is not the kind she can leave once it's started",
    ],
    complications: [
      "but the bond between them is a weakness every rival pack intends to exploit",
      "while the war building at the territory borders turns every personal decision into a strategic one",
      "but the mate bond doesn't care about the history between their families",
      "as the pack politics around them make trust the most dangerous thing either of them can offer",
      "while she refuses to be a treaty term—and the pack law he lives by doesn't allow for that refusal",
      "but every hour she spends with him makes it harder to remember why she has to leave",
    ],
    stakes: [
      "the pack's survival depends on an alliance built on a bond neither of them asked for",
      "war comes for his territory whether she chooses him or not—but her choice changes everything about how it ends",
      "the mate bond either saves them both or destroys the one thing he's spent his life building",
      "her freedom and his pack are on opposite sides of the same decision",
    ],
  },

  // ── SUPERHERO ────────────────────────────────────────────────────────────
  Superhero: {
    heroines: [
      "a burned-out ER doctor who wakes the morning after an accident with abilities she cannot explain",
      "a retired hero living anonymously until a new threat makes staying hidden irresponsible",
      "a forensic scientist who investigates superhuman incidents and has been hiding one of her own for years",
      "a vigilante with a strict no-kill rule facing an enemy who exploits every mercy",
      "a lab technician accidentally dosed with an experimental serum meant for someone else",
      "a journalist embedded with a hero team who starts asking questions they don't want answered",
      "an empath who absorbs the city's grief and is slowly drowning in it",
      "a government handler assigned to manage a hero who cannot be managed",
      "a former villain who genuinely wants to switch sides—but no one will let her",
      "a powered mercenary who has spent years pretending she's something else",
      "a hero's support tech who realizes she's the one making the real decisions",
      "a civilian attorney drafted to defend an accused hero whose case could expose the whole program",
      "a dormant-powered woman activated by a crisis the agency swore couldn't happen",
      "a power broker who facilitated hero contracts and is now being used to dismantle the only protection the city has",
      "a teenage prodigy recruited into a program she doesn't realize is building weapons",
    ],
    coldLeads: [
      "the cold-eyed agency director who wants her power catalogued and contained",
      "a calculating powered operative whose mission overlaps with hers in only one direction",
      "the ruthless hero whose methods she can't endorse but whose results she can't ignore",
      "a composed villain who offers her more honest terms than any hero team has",
      "the icy government official who controls the program funding both of their existences",
      "a former legend who retired for reasons he won't explain and came back for reasons he won't either",
      "the calculating heir to a powered dynasty who sees her as an unregistered variable",
      "an advanced AI system deployed as field support—with authorization levels she doesn't have",
      "the cold-blooded operative sent to recruit her after the agency she works for tried to remove her",
      "a powerful figure who destroyed the last team she was part of and is now asking for her help",
    ],
    incitingEvents: [
      "a threat is classified as impossible by every agency—and then it happens",
      "her secret ability manifests publicly in a way that cannot be explained away",
      "an event she prevented is erased from every record except her memory",
      "a powered individual she was monitoring turns up dead in a way that only another powered person could manage",
      "the agency that trained her burns to the ground and she is listed among the casualties",
      "a distress signal in a frequency only powered individuals can detect leads her somewhere she wasn't supposed to go",
      "the villain she helped put away is released—and the paperwork authorizing it goes back to someone she trusted",
      "a child with abilities contacts her after every official channel turned them away",
      "the power suppression tech that's kept her safe for three years stops working",
      "an old team member surfaces with evidence that the threat they defeated never actually ended",
    ],
    complications: [
      "but the line between hero and threat is being redrawn by people with very specific interests",
      "while the one person with the resources to help her has reasons to let her fail",
      "but every public action she takes makes the target on her back harder to miss",
      "as the agency she's been protecting reveals it was never protecting her back",
      "while the city needs her to be something she's not sure she can sustain",
      "but the cost of what's coming is more than she expected anyone to ask her to pay",
    ],
    stakes: [
      "the city's protection depends on her staying operational when the system wants her offline",
      "the program she's defending will end the career—and possibly the life—of everyone she's worked with",
      "what she does next sets the precedent for every powered person who comes after her",
      "the threat is real, the clock is short, and she is the only one without a political reason to look away",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// Each template is a function that takes filled slots and returns a logline string.
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES = [
  // Template A: Heroine-first, cold lead introduced, complication, stakes
  ({ heroine, coldLead, incitingEvent, complication, stake }) =>
    `When ${incitingEvent}, ${heroine} finds herself entangled with ${coldLead}. ${
      complication.charAt(0).toUpperCase() + complication.slice(1)
    }—${stake}.`,

  // Template B: Situation-first, inciting event as the break point
  ({ heroine, coldLead, incitingEvent, complication, stake }) =>
    `${heroine.charAt(0).toUpperCase() + heroine.slice(1)}'s carefully held life fractures when ${incitingEvent}, throwing her directly into the orbit of ${coldLead}. ${
      complication.charAt(0).toUpperCase() + complication.slice(1)
    }, and ${stake}.`,

  // Template C: Cold lead intro first, heroine as the disruption
  ({ heroine, coldLead, incitingEvent, complication, stake }) =>
    `For ${coldLead}, ${incitingEvent} is nothing but a complication—until ${heroine} refuses to be managed. ${
      complication.charAt(0).toUpperCase() + complication.slice(1)
    }, and ${stake}.`,

  // Template D: Stakes-first, high tension framing
  ({ heroine, coldLead, incitingEvent, complication, stake }) =>
    `${stake.charAt(0).toUpperCase() + stake.slice(1)}—and the only way through runs straight through ${coldLead}. ${
      heroine.charAt(0).toUpperCase() + heroine.slice(1)
    } didn't plan for ${incitingEvent}, and she definitely didn't plan for him. ${
      complication.charAt(0).toUpperCase() + complication.slice(1)
    }.`,
];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_GENRES = Object.keys(SLOTS);

/**
 * Generate a unique procedural logline for the given genre.
 * @param {string} genre - One of the supported genre strings.
 * @returns {string} A unique logline.
 */
export function generateLogline(genre) {
  const normalizedGenre = Object.keys(SLOTS).find(
    (g) => g.toLowerCase() === String(genre || "").toLowerCase()
  ) || "Romance";

  const s = SLOTS[normalizedGenre];

  const heroine      = pick(s.heroines);
  const coldLead     = pick(s.coldLeads);
  const incitingEvent = pick(s.incitingEvents);
  const complication = pick(s.complications);
  const stake        = pick(s.stakes);
  const template     = pick(TEMPLATES);

  return template({ heroine, coldLead, incitingEvent, complication, stake });
}

/**
 * Generate multiple unique loglines (best-effort uniqueness via shuffle).
 * @param {string} genre
 * @param {number} count
 * @returns {string[]}
 */
export function generateLoglines(genre, count = 5) {
  const results = new Set();
  const max = Math.min(count, 50);
  let attempts = 0;
  while (results.size < max && attempts < max * 6) {
    results.add(generateLogline(genre));
    attempts++;
  }
  return [...results];
}

export { SUPPORTED_GENRES };

export default { generateLogline, generateLoglines, SUPPORTED_GENRES };
