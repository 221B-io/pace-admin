import gql from 'graphql-tag'

export default function readPersonsByYearAllCenters (year) {
  const startDateLT = `1/1/${year + 1}`
  const endDateGT = `12/31/${year - 1}`
  return {
    query: gql`
      query MyQuery {
        persons (
          distinct_on: id,
          where: {
            _and: [
              {
                persons_organizations: {
                  start_date: {_lt: "${startDateLT}"}
                }
              }, 
              {
                _or: [
                  {
                    persons_organizations: {
                      end_date: {_gt: "${endDateGT}"}
                    }
                  }, 
                  {
                    persons_organizations: {
                      end_date: {_is_null: true}
                    }
                  }
                ]
              }
            ]
          }, 
          order_by: {id: asc, persons_publications_aggregate: {count: desc}}){
          id
          given_name
          family_name
          start_date
          end_date
          institution {
            name
          }
          persons_namevariances {
            id
            person_id
            given_name
            family_name
          }
          persons_organizations {
            id
            person_id
            start_date
            end_date
          }
          persons_publications_aggregate {
            aggregate {
              count
            }
          }
        }
      }
    `
  }
}
