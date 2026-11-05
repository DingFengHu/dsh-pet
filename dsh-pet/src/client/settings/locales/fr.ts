/**
 * 设置页法语文案；键集与 zh 完全一致。
 */
import type { Key } from './zh.ts';

export const fr: Record<Key, string> = {
  nav: 'Configuration des compagnons',
  intro:
    "Gérez plusieurs compagnons : chacun a sa taille et sa position (appliquées immédiatement après l'enregistrement).",
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: 'Compagnon',
  avatarLabel: 'Avatar',
  avatarHint:
    'La petite image affichée à côté des messages de ce compagnon dans le panneau de discussion. Sans envoi, le logo par défaut du plugin est utilisé ; un envoi prend effet immédiatement et remplace le précédent, sans cliquer sur « Enregistrer ».',
  avatarUpload: 'Envoyer un avatar',
  avatarChange: 'Changer',
  avatarUploading: 'Envoi…',
  avatarUploaded: 'Avatar mis à jour',
  petCardHint:
    'Réglages par compagnon : nom / taille / affichage / coin / décalages / les quatre interrupteurs de fonctionnalités. Cliquez sur « Enregistrer » en bas pour appliquer immédiatement.',
  globalTitle: 'Interrupteurs globaux',
  globalHint:
    "Partagés par tous les compagnons (un pet pack peut les remplacer dans son propre fichier de type). Ces interrupteurs ne modifient que l'état local et sont écrits dans la configuration utilisateur lors de l'enregistrement (jamais immédiatement) ; les notifications système sont relues juste après l'enregistrement, sans rafraîchir la page.",
  cornerHint: "Le coin de l'écran auquel le compagnon se colle (par zone de travail de chaque écran en mode bureau).",
  marginXHint: "Distance horizontale au coin choisi (px) ; n'importe quel nombre.",
  marginYHint: "Distance verticale au coin choisi (px) ; n'importe quel nombre.",
  // 「/」命令菜单的行标题（图标由 app.ts 经 command-faces.ts 补上）。
  'cmd.chat': 'Discussion',
  'cmd.pet': 'Compagnon',
  'cmd.balance': 'Solde',
  'shortcut.open': 'Ouvrir le chat du compagnon',
  'shortcut.chat': 'Ouvrir la fenêtre de chat',
  'shortcut.hear': 'Saisie vocale',
  'shortcut.capture': 'Capture d’écran vers le chat',
  shortcutCardTitle: 'Raccourcis',
  shortcutCardHint: 'Deux groupes une fois déployé : raccourcis du compagnon et raccourcis globaux.',
  shortcutRowTodo: 'Tâches',
  shortcutRowDisplay: 'Position d’affichage',
  shortcutGroupPet: 'Raccourcis du compagnon',
  shortcutGroupPetHint:
    'Sur le web, il suffit de survoler le compagnon. Dans la fenêtre du bureau, cliquez d’abord sur le compagnon pour qu’il prenne le focus clavier.',
  petsLabel: 'Compagnons',
  add: 'Ajouter un compagnon',
  remove: 'Supprimer',
  confirmRemove: 'Supprimer le compagnon « {id} » ?',
  confirmTitle: "Confirmer l'action",
  cancel: 'Annuler',
  ok: 'Compris',
  atLeastOne: 'Gardez au moins un compagnon.',
  emptyPets: "Aucun compagnon pour l'instant — cliquez sur « Ajouter un compagnon » pour en créer un.",
  sizeLabel: 'Taille (largeur px)',
  sizeHint: 'La hauteur est automatique = largeur × 9/16.',
  sizePercentLabel: 'Largeur d’écran max (%)',
  sizePercentHint:
    'Part de la largeur d’écran que le pet peut occuper : 100 = jamais plus large qu’un écran (identique au px sur une fenêtre large) ; 30–40 le rend nettement plus petit sur téléphone sans changer le bureau. Calculé une fois au chargement ; rechargez après redimensionnement.',
  nameLabel: 'Nom',
  nameHint:
    "Affiché au survol du compagnon et ajouté aux personas de l'IA (« votre nom est X »). Les doublons sont permis ; laissé vide, l'identifiant du compagnon est utilisé.",
  workStatusEnabled: "Suivi de l'état de travail",
  workStatusEnabledHint:
    "Une fois activé, ce compagnon suit l'état de travail de DSH : réflexion / travail / attente de confirmation / terminé / erreur déclenchent l'animation correspondante et une bulle (le pool se trouve au niveau supérieur de la configuration ; écoute seule, aucun appel au modèle).",
  fixedEnabled: 'Compagnon fixe',
  fixedEnabledHint:
    "Une fois activé, la chaîne aléatoire ne fait plus se retourner ni s'éloigner le compagnon — seules les actions sur place sont jouées. Les déclenchements par menu contextuel et par API, ainsi que les animations solde / murmure / état de travail, ne sont pas affectés.",
  displayLabel: 'Affichage',
  displayHint: 'web = navigateur seul / desktop = bureau seul / both = les deux / none = aucun',
  'display.web': 'Navigateur seul',
  'display.desktop': 'Bureau seul',
  'display.both': 'Les deux',
  'display.none': 'Aucun',
  cornerLabel: 'Position',
  'corner.top-left': 'En haut à gauche',
  'corner.top-right': 'En haut à droite',
  'corner.bottom-left': 'En bas à gauche',
  'corner.bottom-right': 'En bas à droite',
  marginX: 'Décalage horizontal',
  marginY: 'Décalage vertical',
  save: 'Enregistrer',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: 'Synchroniser',
  confirmSync:
    'Synchroniser ? La configuration par défaut intégrée (tous les champs + commentaires) remplacera la configuration utilisateur ; vos personnalisations actuelles seront perdues.',
  corruptTitle: 'Configuration utilisateur corrompue — non enregistrée',
  corruptConfirm: 'Enregistrer quand même',
  corruptBody:
    'Le fichier de configuration utilisateur est illisible (corrompu, JSON/JSONC invalide) : {path}. Enregistrer maintenant le reconstruit à partir de la liste blanche — tout son contenu actuel (animations / physics / memes, etc.) sera perdu. Annuler = ne pas toucher au fichier (corrigez-le puis enregistrez) ; Confirmer = enregistrer quand même (le contenu actuel du fichier est abandonné).',
  syncHint:
    "« Synchroniser » écrit la configuration par défaut intégrée (commentaires et tous les champs avancés compris) dans le fichier de configuration utilisateur, en écrasant vos personnalisations ; le fichier est ensuite modifiable directement. Deux réserves : (1) une fois créé, ce fichier est une couche de remplacement explicite — les changements ultérieurs des valeurs par défaut intégrées ne s'appliquent pas automatiquement (sauf nouvelle synchronisation ou suppression du fichier) ; (2) cliquer sur « Enregistrer » sur cette page réécrit le fichier à partir d'une liste blanche — les valeurs sont conservées, les commentaires disparaissent.",
  configMeta: 'Configuration avancée (fichiers)',
  configMetaHint:
    "La configuration utilisateur peut remplacer la liste des compagnons / les pools d'animation / les poids ; rechargez la page ou redémarrez pour appliquer : rafraîchissez la page dans le navigateur, ou sur le bureau, clic droit sur un compagnon → « Recharger la configuration » (reconstruit toutes les fenêtres de compagnons). La configuration par défaut est la référence complète.",
  defaultConfig: 'Configuration par défaut (lecture seule, référence complète)',
  userConfig: 'Configuration utilisateur (remplacements personnalisés)',
  todosFile: 'Données de tâches (texte, échéance et état ; les supprimer vide toutes les tâches)',
  animationDir: 'Dossier des animations (pour ajouter ou personnaliser des animations)',
  memesDir: 'Dossier des mèmes (pour ajouter ou personnaliser des images)',
  logFile: 'Fichier journal (pour le dépannage ; peut être vidé)',
  logFileNote:
    "L'application de bureau n'a pas de console : tous les journaux d'exécution du plugin (démarrage, plantages / redémarrages des compagnons, erreurs et avertissements) sont écrits dans ce seul fichier — joignez-le à vos rapports de problème. Limité à 1 Mo ; une fois plein, seuls les 512 Ko les plus récents sont conservés.",
  saved: 'Enregistré — les compagnons sont à jour immédiatement.',
  loadError: 'Échec du chargement de la configuration',
  saveError:
    "Échec de l'enregistrement de la configuration. Vérifiez la connexion au serveur, les droits d'écriture du dossier de configuration et le journal du serveur.",
  saveInvalid: "Échec de l'enregistrement : configuration invalide. Vérifiez les valeurs et réessayez.",
  syncError:
    "Échec de la synchronisation. Vérifiez la connexion au serveur et les droits d'écriture du dossier de configuration.",
  loading: 'Chargement de la configuration…',
  retry: 'Réessayer',
  invalid: "Vérifiez votre saisie : la taille doit être positive ; les marges peuvent être n'importe quel nombre.",
  busy: 'Enregistrement…',
  extraPetsHint:
    "{n} autre(s) type(s) proviennent de fichiers du dossier pet/ (<nom>-config.json + <nom>-animation/) ; basculez dessus dans la ligne « Types » ci-dessus. L'enregistrement écrit dans la configuration propre à chaque pack, jamais dans main-config.jsonc.",
  kindLabel: 'Types',
  kindMain: 'Intégré',
  lastOfKind:
    "« {entry} » n'a plus que ce compagnon — le supprimer ferait disparaître tout le type. Pour le retirer complètement, supprimez les fichiers du pack.",
  savePartial:
    "Compagnons principaux enregistrés, mais {names} n'ont pas pu être écrits : vérifiez que la configuration du pack est valide et que le dossier est accessible en écriture.",
  notifyToggle: 'Notifications système',
  notifyToggleHint:
    "Notifications du système d'exploitation (en bas à droite du bureau) pour la fin d'une conversation, les échecs, les demandes de permission et les questions — uniquement lorsque cette fenêtre n'a pas le focus.",
  clickSoundToggle: 'Son au clic',
  clickSoundToggleHint:
    "Joue le son intégré (assets/sound/click-duck.wav, volume 0,5) quand on clique sur un compagnon ; les clics répétés en moins de 100 ms ne sonnent qu'une fois, donc plusieurs compagnons ne se superposent jamais. Désactivez-le pour un silence total. Écrit dans la configuration utilisateur avec « Enregistrer ».",
  confineToggle: "Limiter à l'écran actuel",
  confineToggleHint:
    "Multi-écrans : une fois activé, le compagnon reste sur l'écran où il se trouve — un compagnon lancé ne rebondit que sur l'écran du relâchement (les jointures d'écrans font office de murs, il ne passe pas sur l'écran voisin) et l'errance autonome ne se fait que sur l'écran actuel (tout pas qui franchirait la jointure est annulé). Désactivé, il traverse les écrans comme d'habitude. Mode bureau uniquement — l'overlay du navigateur reste de toute façon dans la zone visible.",
  trayToggle: 'Zone de notification',
  trayToggleHint:
    "Affiche une icône dans la zone de notification (barre de menus sur macOS) dès que le mode bureau démarre. Elle liste tous les compagnons de la configuration et permet de basculer chacun entre bureau et web / aucun — y compris ceux qui ne sont pas sur le bureau et n'ont donc aucune fenêtre à cliquer droit. Une fois désactivée, ramener un compagnon sur le bureau exige d'ouvrir le navigateur (la page de configuration, ou un clic droit sur le compagnon web). Windows range déjà ces icônes dans le panneau « icônes masquées ». Mode bureau uniquement.",
  voiceTitle: 'Synthèse vocale',
  voiceHint:
    "Trois interrupteurs et une voix : l'interrupteur principal commande la lecture automatique, les deux sous-interrupteurs commandent chacun un type de message proactif. Tout est désactivé par défaut et écrit dans la configuration utilisateur lors de l'enregistrement (jamais immédiatement).",
  voiceEnabled: 'Lecture vocale',
  voiceEnabledHint:
    "Interrupteur principal de la lecture automatique. Désactivé, les murmures périodiques et les rappels de tâches restent muets (les deux sous-interrupteurs ci-dessous n'ont alors aucun effet). Les murmures manuels, les réponses de discussion et le bouton haut-parleur du panneau de discussion ne sont pas concernés — vous les avez demandés, la surface qui les déclenche les lit directement. Cela ne décide que du son émis : bulles, mémoire de discussion et notifications système restent intactes ; un échec de synthèse est seulement journalisé et n'interrompt jamais la conversation.",
  voiceTodoEnabled: 'Lire les rappels de tâches',
  voiceTodoEnabledHint:
    "Lit un rappel de tâche à son échéance (la bulle s'affiche toujours ; cet interrupteur décide seulement s'il est lu). Soumis à l'interrupteur principal ci-dessus. Désactivé par défaut.",
  voiceNameLabel: 'Voix',
  voiceVolumeLabel: 'Volume',
  voiceVolumeHint:
    'Volume de lecture en décimal 0–1 : 1 correspond au volume maximal (100 %), 0 coupe le son. Seule l’intensité change et l’audio n’est pas resynthétisé, donc le régler ne coûte rien de plus. Indépendant de l’interrupteur général ci-dessus : il est sans effet quand celui-ci est désactivé.',
  physicsTitle: 'Physique (ressenti du glisser-lancer)',
  physicsHint:
    "Valeurs par défaut globales, partagées par tous les compagnons (un pet pack peut les remplacer dans son propre fichier de type) ; écrites dans la configuration utilisateur lors de l'enregistrement (jamais immédiatement). Appliquées immédiatement dans le navigateur ; sur le bureau, après que l'enregistrement a rechargé les fenêtres des compagnons.",
  mobileTitle: 'Effets mobiles',
  mobileHint:
    "Ces réglages n'ont de sens que dans un navigateur mobile : la vibration exige un moteur, les deux interrupteurs de mouvement exigent des capteurs d'inclinaison / d'accélération, et ces capteurs ne fonctionnent qu'en HTTPS ou sur localhost.",
  'physics.gravity': 'Gravité',
  'physics.gravityHint':
    'px/s², plus la valeur est élevée, plus la chute est rapide ; 0 = apesanteur (trajectoire rectiligne uniforme)',
  'physics.restitution': 'Rebond',
  'physics.restitutionHint':
    '0 à 1, proportion de vitesse conservée lors du rebond contre un mur ou le sol (1 = parfaitement élastique, 0 = arrêt net)',
  'physics.groundFriction': 'Frottement de contact',
  'physics.groundFrictionHint':
    'par seconde, atténuation de la vitesse le long de toute surface touchée (mur, sol, plafond) ; 0 = verglas partout',
  'physics.throwPower': 'Force de lancer',
  'physics.throwPowerHint':
    '> 0, multiplicateur global du suivi ressort et de la vitesse de lancer (1 = valeur par défaut ; plus haut = suivi plus ferme et lancers plus violents)',
  physicsCeilingBounce: 'Rebond au plafond',
  physicsCeilingBounceHint: "Désactivé, un lancer peut sortir par le haut de l'écran (la gravité le ramène)",
  physicsPetCollision: 'Collisions entre compagnons',
  physicsPetCollisionHint:
    'Un compagnon en vol rebondit sur les autres en conservant la quantité de mouvement (masse ∝ taille²)',
  physicsHaptic: 'Vibration aux collisions',
  physicsHapticHint:
    'Une vibration par impact (murs, sol, plafond, autres compagnons). Fonctionne dans Chrome/Edge ; pas sur iOS ni dans les coques WebView comme Via. Le mode Ne pas déranger la bloque.',
  physicsTilt: 'Gravité par inclinaison',
  physicsTiltHint:
    'Inclinez le téléphone : la gravité suit (valeur = celle ci-dessus) ; avec une gravité à 0, l’inclinaison n’a aucun effet. Nécessite HTTPS/localhost.',
  physicsShake: 'Secouer pour lancer',
  physicsShakeHint:
    'Secouez pour lancer le compagnon dans le sens du geste ; la force suit throwPower. Indépendant de la gravité, donc utilisable à gravité 0. Nécessite HTTPS/localhost.',
  invalidPhysics:
    'Vérifiez les paramètres physiques : gravité / frottement au sol ≥ 0, rebond entre 0 et 1, force de lancer > 0.',
  fontTitle: 'Apparence et police',
  fontHint:
    "La famille s'applique partout où la police bonbon est utilisée : bulle du compagnon, infobulle, fenêtre de discussion, fenêtre de score ; la taille ne concerne que la bulle et l'infobulle (les fenêtres de discussion et de score gardent la leur). Valeurs globales par défaut, partagées par tous les compagnons (un pet pack peut les remplacer dans son propre fichier de type) ; écrites dans la configuration utilisateur lors de l'enregistrement — immédiat dans le navigateur, et sur le bureau après rechargement des fenêtres par l'enregistrement.",
  fontFamilyLabel: 'Police',
  fontFamilyHint:
    "« Bonbon (intégrée) » est fournie avec le plugin ; les autres sont des polices système. Si une police manque sur la machine, la pile passe à la suivante (jamais de vide ni d'erreur).",
  fontSizeLabel: 'Taille de police (px)',
  fontSizeHint:
    "Taille du texte des bulles ; l'infobulle et les petites lignes de la bulle suivent proportionnellement. Plage 4 à 200.",
  fontFollowToggle: "Mettre la police à l'échelle du compagnon",
  fontFollowToggleHint:
    'Activé (par défaut) : la police grandit avec le compagnon — à 462 px de largeur, elle correspond exactement à la taille ci-dessus. Désactivé : la taille reste fixe quelle que soit la taille du compagnon.',
  invalidFont:
    'Vérifiez les réglages de police : la famille doit figurer dans la liste et la taille doit être un nombre entre 4 et 200.',
  'font.candy': 'Bonbon (intégrée)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'Police système',
  notifyTest: 'Tester la notification',
  notifyTestOk: 'Notification de test envoyée — regardez en bas à droite de votre bureau.',
  notifyDenyUnsupported:
    "Les notifications système ne sont pas prises en charge dans cet environnement (pas d'API Notification).",
  notifyDenyBlocked: "L'autorisation de notification est bloquée par le navigateur.",
  notifyDenyRejected: "Vous avez choisi « Bloquer » dans la demande d'autorisation.",
  notifyDenyError: "Échec de la demande d'autorisation",
  notifyGuide:
    "Marche à suivre : cliquez sur l'icône 🔒/ⓘ à gauche de la barre d'adresse → « Paramètres du site » → « Notifications » → choisissez « Autoriser », puis rafraîchissez la page et réessayez.",
  storageTitle: 'Désinstallation et stockage',
  storageHint:
    'Tous les emplacements où ce plugin écrit sur la machine. Supprimer les caches est sans risque (ils sont retéléchargés / reconstruits) ; supprimer les « données utilisateur du plugin » fait perdre la configuration et la mémoire de discussion.',
  'storage.userData':
    'Données utilisateur du plugin : configuration personnalisée main-config.jsonc, mémoire de discussion memory.json, animations personnalisées main-animation/, compagnons fichiers pet/',
  'storage.electron':
    'Runtime Electron du compagnon de bureau (volumineux ; retéléchargé automatiquement au prochain démarrage du mode bureau)',
  'storage.desktopCache':
    "Cache des fenêtres de compagnons et cache d'échelle de l'écran principal (suppression sans risque, reconstruit automatiquement)",
  'storage.electronCache':
    "Cache de téléchargement de l'installateur Electron (suppression sans risque, retéléchargé si besoin)",
  'storage.package':
    'Le plugin lui-même (géré par DSH — retirez-le avec la commande ci-dessous plutôt que de le supprimer à la main)',
  storageMissing: ' (pas encore créé)',
  uninstallTitle: 'Comment désinstaller',
  uninstallStep1:
    "1. Quittez d'abord DSH (le compagnon de bureau s'arrête avec lui) ; ne supprimez pas ces fichiers pendant que le compagnon tourne.",
  uninstallStep2:
    '2. Retirez le plugin lui-même (dans un terminal ; il est aussi retiré de la couche bundle du profil) :',
  uninstallStep3:
    '3. Supprimez les emplacements ci-dessus selon vos besoins : les caches sont sans risque ; supprimer les « données utilisateur du plugin » fait perdre la configuration et la mémoire de discussion (sauvegardez main-config.jsonc si vous voulez le garder).',
  motionTitle: 'Fréquence des actions',
  motionHint:
    "Quatre champs : repos / rotation / déplacement sont modifiables ; l'action aléatoire est calculée (100 − les trois autres). Valeur globale pour tous les compagnons ; un pet pack peut la remplacer dans son fichier de type.",
  'motion.idle': 'Repos',
  'motion.turn': 'Rotation',
  'motion.move': 'Déplacement',
  'motion.action': 'Action aléatoire',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};
