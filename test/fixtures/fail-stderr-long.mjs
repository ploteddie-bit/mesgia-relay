// Fixture pour M2 (borne) : écrit un marqueur au début, un gros padding, puis
// un marqueur à la fin. Le buffer stderr du relais est borné à 4000 chars :
// seul le début doit être conservé, le marqueur de fin doit être ignoré.
process.stderr.write('DEBUT_MARQUEUR ' + 'A'.repeat(5000) + ' FIN_MARQUEUR')
process.exit(1)
