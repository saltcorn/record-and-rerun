NUM_ITERATIONS=${NUM_ITERATIONS:-1}
DO_BENCHMARK=${DO_BENCHMARK:-false}

echo NUM_ITERATIONS is $NUM_ITERATIONS
echo DO_BENCHMARK is $DO_BENCHMARK

PGDATABASE=saltcorn saltcorn serve -p 3010 &
SCPID=$!
trap "kill $SCPID" EXIT

while ! nc -z localhost 3010; do   
  sleep 0.2 
done

for i in $(seq 1 "$NUM_ITERATIONS"); do
  echo "▶️  Run $i of $NUM_ITERATIONS"
  if [ "$DO_BENCHMARK" = true ]; then
    DO_BENCHMARK=true npx playwright test
  else
    npx playwright test
  fi
done
