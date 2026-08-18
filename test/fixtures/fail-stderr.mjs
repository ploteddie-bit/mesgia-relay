// Fixture pour M2 : écrit un marqueur sur stderr puis sort en erreur.
process.stderr.write('ERREUR_SPECIFIQUE_DE_TEST: échec simulé\n')
process.exit(1)
