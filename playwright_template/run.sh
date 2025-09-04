PGDATABASE=saltcorn saltcorn serve -p 3010 &
SCPID=$!
trap "kill $SCPID" EXIT

while ! nc -z localhost 3010; do   
  sleep 0.2 
done

npx playwright test
