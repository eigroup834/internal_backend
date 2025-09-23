const { Country, State, City } = require("country-state-city");

exports.getCountries = async (req, res) => {
  try {
    const countries = Country.getAllCountries().map(c => ({
      name: c.name,
      isoCode: c.isoCode,  
      phonecode: c.phonecode,
      flag: c.flag,
    }));
    res.json(countries);
  } catch (err) {
    console.error("Country fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getStates = async (req, res) => {
  try {
    const { country } = req.query; 
    if (!country) return res.json([]);

    const states = State.getStatesOfCountry(country).map(s => ({
      name: s.name,
      isoCode: s.isoCode, 
    }));
    res.json(states);
  } catch (err) {
    console.error("State fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getCities = async (req, res) => {
  try {
    const { country, state } = req.query; 
    if (!country || !state) return res.json([]);

    const cities = City.getCitiesOfState(country, state).map(c => ({
      name: c.name,
    }));
    res.json(cities);
  } catch (err) {
    console.error("City fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
